#!/bin/bash
set -euo pipefail
if (($#!=6));then printf 'usage: %s <intent.json> <attestation-bundle> <canonical-anchor.json> <owner/repo> <signer-key-id> <entry-output>\n' "$0" >&2;exit 64;fi
intent=$1;bundle=$2;anchor=$3;repository=$4;signer=$5;output=$6
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && -f $intent && ! -L $intent && -f $bundle && ! -L $bundle && -f $anchor && ! -L $anchor && ! -e $output ]]||exit 65
node=;for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node;do [[ -x $candidate && ! -L $candidate ]]&&{ node=$candidate;break;};done;[[ -n $node ]]||exit 69
anchor_summary=$("$node" scripts/verify-production-policy-anchor.mjs "$anchor")
workflow=$(jq -r .rotationWorkflowRef <<<"$anchor_summary");workflow_identity=${workflow%@*}
evidence=$(mktemp "${TMPDIR:-/tmp}/policy-attestation.XXXXXX");trust=$(mktemp "${TMPDIR:-/tmp}/policy-trust.XXXXXX");trap 'rm -f -- "$evidence" "$trust" "$output"' ERR HUP INT TERM
gh attestation verify "$intent" --bundle "$bundle" --repo "$repository" --signer-workflow "$workflow_identity" --format json >"$evidence"
"$node" - "$intent" "$anchor_summary" "$repository" "$trust" <<'NODE'
const fs=require("fs"),intent=JSON.parse(fs.readFileSync(process.argv[2])),anchor=JSON.parse(process.argv[3]),repo=process.argv[4],trust=process.argv[5],identity=anchor.rotationWorkflowRef.split("@")[0],ref=anchor.rotationWorkflowRef.slice(identity.length+1);
if(intent.repositoryName!==repo||anchor.rotationRepositoryName!==repo||intent.repositoryId!==anchor.rotationRepositoryId||intent.anchorSha256!==anchor.anchorSha256||intent.anchorGeneration!==anchor.anchorGeneration||intent.nextGeneration!==anchor.ledgerGeneration+1||intent.previousReceiptDigest!==anchor.ledgerReceiptDigest||intent.trustedWorkflowRef!==anchor.rotationWorkflowRef||intent.trustedWorkflowSha!==anchor.rotationWorkflowSha)process.exit(1);
fs.writeFileSync(trust,JSON.stringify({repository:repo,workflowIdentity:identity,workflowRef:ref,workflowSha:anchor.rotationWorkflowSha}));
NODE
"$node" infra/bootstrap/verify-attestation-identity.mjs "$evidence" "$trust" "$intent"
set -C
"$node" scripts/create-production-policy-ledger-entry.mjs "$intent" "$signer" >"$output"
chmod 0444 "$output"
rm -f -- "$evidence" "$trust";trap - ERR HUP INT TERM
