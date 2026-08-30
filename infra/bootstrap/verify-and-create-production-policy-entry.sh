#!/bin/bash
set -euo pipefail
if (($#!=9));then printf 'usage: %s <intent.json> <attestation-bundle> <canonical-anchor.json> <owner/repo> <expected-run-id> <expected-run-attempt> <expected-policy-bundle-sha256> <signer-key-id> <entry-output>\n' "$0" >&2;exit 64;fi
root=${STEAM_TOP_CEREMONY_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)};tools=$root;[[ -f $tools/verify-production-policy-anchor.mjs && -f $tools/create-production-policy-ledger-entry.mjs ]]||tools=$(CDPATH= cd -- "$root/../../scripts"&&pwd -P);intent=$1;bundle=$2;anchor=$3;repository=$4;expected_run=$5;expected_attempt=$6;expected_bundle=$7;signer=$8;output=$9
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $expected_run =~ ^[1-9][0-9]*$ && $expected_attempt =~ ^[1-9][0-9]*$ && $expected_bundle =~ ^[a-f0-9]{64}$ && -f $intent && ! -L $intent && -f $bundle && ! -L $bundle && -f $anchor && ! -L $anchor && ! -e $output ]]||exit 65
node=;for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node;do [[ -x $candidate && ! -L $candidate ]]&&{ node=$candidate;break;};done;[[ -n $node ]]||exit 69
anchor_summary=$("$node" "$tools/verify-production-policy-anchor.mjs" "$anchor");workflow=$(jq -r .rotationWorkflowRef <<<"$anchor_summary");workflow_identity=${workflow%@*}
evidence=$(mktemp "${TMPDIR:-/tmp}/policy-attestation.XXXXXX");trust=$(mktemp "${TMPDIR:-/tmp}/policy-trust.XXXXXX");trap 'rm -f -- "$evidence" "$trust" "$output"' ERR HUP INT TERM
gh attestation verify "$intent" --repo "$repository" --signer-workflow "$workflow_identity" --format json --bundle "$bundle" >"$evidence"
"$node" - "$intent" "$anchor_summary" "$repository" "$expected_run" "$expected_attempt" "$expected_bundle" "$trust" <<'NODE'
const fs=require("fs"),intent=JSON.parse(fs.readFileSync(process.argv[2])),anchor=JSON.parse(process.argv[3]),repo=process.argv[4],run=process.argv[5],attempt=process.argv[6],bundle=process.argv[7],trust=process.argv[8],identity=anchor.rotationWorkflowRef.split("@")[0],ref=anchor.rotationWorkflowRef.slice(identity.length+1),zero="0".repeat(64),genesis=anchor.ledgerGeneration===0&&anchor.ledgerReceiptDigest===zero&&anchor.ledgerAnchorGeneration===0&&anchor.ledgerAnchorSha256===zero;
if(intent.repositoryName!==repo||anchor.rotationRepositoryName!==repo||intent.repositoryId!==anchor.rotationRepositoryId||String(intent.runId)!==run||String(intent.runAttempt)!==attempt||intent.bundleSha256!==bundle||intent.anchorSha256!==anchor.anchorSha256||intent.anchorGeneration!==anchor.anchorGeneration||intent.nextGeneration!==anchor.ledgerGeneration+1||intent.previousReceiptDigest!==anchor.ledgerReceiptDigest||(intent.nextGeneration===1)!==genesis||intent.trustedWorkflowRef!==anchor.rotationWorkflowRef||intent.trustedWorkflowSha!==anchor.rotationWorkflowSha)process.exit(1);
fs.writeFileSync(trust,JSON.stringify({repository:repo,workflowIdentity:identity,workflowRef:ref,workflowSha:anchor.rotationWorkflowSha}));
NODE
"$node" "$root/verify-attestation-identity.mjs" "$evidence" "$trust" "$intent"
set -C;"$node" "$tools/create-production-policy-ledger-entry.mjs" "$intent" "$signer" >"$output";chmod 0444 "$output"
rm -f -- "$evidence" "$trust";trap - ERR HUP INT TERM
