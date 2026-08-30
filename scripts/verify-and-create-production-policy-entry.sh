#!/bin/bash
set -euo pipefail
if (($#!=6));then printf 'usage: %s <intent.json> <attestation-bundle> <canonical-anchor.json> <owner/repo> <signer-key-id> <entry-output>\n' "$0" >&2;exit 64;fi
intent=$1;bundle=$2;anchor=$3;repository=$4;signer=$5;output=$6
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && -f $intent && ! -L $intent && -f $bundle && ! -L $bundle && -f $anchor && ! -L $anchor && ! -e $output ]]||exit 65
anchor_summary=$(/usr/bin/node scripts/verify-production-policy-anchor.mjs "$anchor")
workflow="$repository/.github/workflows/rotate-production-policy.yml"
gh attestation verify "$intent" --bundle "$bundle" --repo "$repository" --signer-workflow "$workflow" >/dev/null
/usr/bin/node - "$intent" "$anchor_summary" "$repository" "$workflow" <<'NODE'
const fs=require("fs"),crypto=require("crypto"),intent=JSON.parse(fs.readFileSync(process.argv[2])),anchor=JSON.parse(process.argv[3]),repo=process.argv[4],workflow=process.argv[5];
if(intent.repositoryName!==repo||intent.anchorSha256!==anchor.anchorSha256||intent.anchorGeneration!==anchor.anchorGeneration||intent.trustedWorkflowRef!==`${workflow}@refs/heads/main`)process.exit(1);
NODE
set -C
trap 'rm -f -- "$output"' ERR HUP INT TERM
/usr/bin/node scripts/create-production-policy-ledger-entry.mjs "$intent" "$signer" >"$output"
chmod 0444 "$output"
trap - ERR HUP INT TERM
