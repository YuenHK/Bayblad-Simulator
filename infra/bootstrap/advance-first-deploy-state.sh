#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 2 && $1 =~ ^(pending|db-claimed|consumed)$ && $2 =~ ^[a-f0-9]{64}$ ]]||exit 2
phase=$1;nonce=$2;root=/var/lib/steam-top-bootstrap/first-deploy;lock=/var/lock/steam-top-production.lock
[[ -f $lock && ! -L $lock && $(stat -c '%u %a' "$lock") == '0 600' ]]
# The canonical host core already owns fd 9. Re-opening the same inode in its
# child creates another open-file description and deadlocks on our own flock.
if [[ -e /proc/$$/fd/9 && $(readlink -f /proc/$$/fd/9) == "$lock" ]];then
  flock -n 9
else
  exec 9<>"$lock";flock 9
fi
install -d -o root -g root -m 0700 "$root/generations";current=;[[ ! -L $root/current ]]||current=$(realpath "$root/current")
if [[ -n $current ]];then prev=$(basename "$current");read -r old_phase old_nonce _ < <(/opt/steam-top-bootstrap/read-first-deploy-state.sh);[[ $old_nonce == "$nonce" ]];case "$old_phase:$phase" in pending:pending|pending:db-claimed|db-claimed:db-claimed|db-claimed:consumed|consumed:consumed);;*)exit 1;;esac;[[ $old_phase != "$phase" ]]||exit 0;else prev=null;[[ $phase == pending ]]||exit 1;fi
config=/etc/steam-top-bootstrap/trust.json;read -r receipt_digest receipt_nonce host digest < <(/opt/steam-top-bootstrap/read-install-receipt.sh);[[ $receipt_nonce == "$nonce" ]];key=$(node -p 'require(process.argv[1]).productionStateSigningKey' "$config");allowed=$(node -p 'require(process.argv[1]).productionStateAllowedSigners' "$config");signer=$(node -p 'require(process.argv[1]).productionStateSignerId' "$config");tmp=$(mktemp -d "$root/generations/.stage.XXXXXX");node - "$tmp/payload.json" "$phase" "$nonce" "$host" "$digest" "$receipt_digest" "$prev" "$signer" <<'NODE'
const fs=require("fs"),[out,phase,authorizationNonce,hostId,bootstrapDigest,installReceiptDigest,previousDigest,signerKeyId]=process.argv.slice(2);fs.writeFileSync(out,JSON.stringify({schemaVersion:1,purpose:"steam-top-first-deploy-state",phase,authorizationNonce,hostId,bootstrapDigest,installReceiptDigest,previousDigest:previousDigest==="null"?null:previousDigest,signerKeyId})+"\n",{mode:0o400});
NODE
ssh-keygen -Y sign -q -f "$key" -n steam-top-first-deploy-state "$tmp/payload.json";chmod 0400 "$tmp/payload.json.sig";id=$(sha256sum "$tmp/payload.json"|awk '{print $1}');chmod 0500 "$tmp";sync -f "$tmp";mv "$tmp" "$root/generations/$id";sync -f "$root/generations";ln -s "$id" "$root/.current.$$.tmp";mv -Tf "$root/.current.$$.tmp" "$root/current";sync -f "$root"
