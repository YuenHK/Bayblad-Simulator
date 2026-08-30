#!/bin/bash
set -euo pipefail
if (($#!=6));then printf 'usage: %s <intent.json> <attestation-bundle> <canonical-anchor.json> <owner/repo> <signer-key-id> <entry-output>\n' "$0" >&2;exit 64;fi
intent=$1;bundle=$2;anchor=$3;repository=$4;signer=$5;output=$6
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && -f $intent && ! -L $intent && -f $bundle && ! -L $bundle && -f $anchor && ! -L $anchor && ! -e $output ]]||exit 65
anchor_summary=$(/usr/bin/node scripts/verify-production-policy-anchor.mjs "$anchor")
workflow="$repository/.github/workflows/rotate-production-policy.yml"
evidence=$(mktemp "${TMPDIR:-/tmp}/policy-attestation.XXXXXX");trust=$(mktemp "${TMPDIR:-/tmp}/policy-trust.XXXXXX");trap 'rm -f -- "$evidence" "$trust" "$output"' ERR HUP INT TERM
gh attestation verify "$intent" --bundle "$bundle" --repo "$repository" --signer-workflow "$workflow" --format json >"$evidence"
/usr/bin/node - "$intent" "$anchor_summary" "$repository" "$workflow" "$trust" <<'NODE'
const fs=require("fs"),intent=JSON.parse(fs.readFileSync(process.argv[2])),anchor=JSON.parse(process.argv[3]),repo=process.argv[4],workflow=process.argv[5],trust=process.argv[6];
if(intent.repositoryName!==repo||intent.anchorSha256!==anchor.anchorSha256||intent.anchorGeneration!==anchor.anchorGeneration||!new RegExp(`^${workflow.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}@refs/heads/[A-Za-z0-9._/-]+$`).test(intent.trustedWorkflowRef))process.exit(1);
fs.writeFileSync(trust,JSON.stringify({repository:repo,workflowIdentity:workflow,workflowRef:intent.trustedWorkflowRef.slice(workflow.length+1),workflowSha:intent.trustedWorkflowSha}));
NODE
/usr/bin/node infra/bootstrap/verify-attestation-identity.mjs "$evidence" "$trust" "$intent"
set -C
/usr/bin/node scripts/create-production-policy-ledger-entry.mjs "$intent" "$signer" >"$output"
chmod 0444 "$output"
rm -f -- "$evidence" "$trust";trap - ERR HUP INT TERM
