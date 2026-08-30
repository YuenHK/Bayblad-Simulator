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
install -d -o root -g root -m 0700 "$root/generations";config=/etc/steam-top-bootstrap/trust.json;read -r receipt_digest receipt_nonce host digest < <(/opt/steam-top-bootstrap/read-install-receipt.sh);[[ $receipt_nonce == "$nonce" ]];key=$(node -p 'require(process.argv[1]).productionStateSigningKey' "$config");allowed=$(node -p 'require(process.argv[1]).productionStateAllowedSigners' "$config");signer=$(node -p 'require(process.argv[1]).productionStateSignerId' "$config");current=;[[ ! -L $root/current ]]||current=$(realpath "$root/current")
if [[ -n $current ]];then
  prev=$(basename "$current")
  # Recover the single fully-published next generation when a crash happened
  # after its directory fsync but before the atomic current-pointer swap.
  mapfile -t recovery < <(node - "$root/generations" "$prev" "$phase" "$nonce" "$host" "$digest" "$receipt_digest" <<'NODE'
const fs=require("fs"),path=require("path"),crypto=require("crypto"),[root,previousDigest,phase,authorizationNonce,hostId,bootstrapDigest,installReceiptDigest]=process.argv.slice(2);for(const id of fs.readdirSync(root)){if(!/^[a-f0-9]{64}$/.test(id)||id===previousDigest)continue;const p=path.join(root,id,"payload.json");if(!fs.existsSync(p))continue;const raw=fs.readFileSync(p),x=JSON.parse(raw);if(crypto.createHash("sha256").update(raw).digest("hex")===id&&x.schemaVersion===1&&x.purpose==="steam-top-first-deploy-state"&&x.previousDigest===previousDigest&&x.phase===phase&&x.authorizationNonce===authorizationNonce&&x.hostId===hostId&&x.bootstrapDigest===bootstrapDigest&&x.installReceiptDigest===installReceiptDigest)console.log(p)}
NODE
  )
  [[ ${#recovery[@]} -le 1 ]]||exit 1
  if [[ ${#recovery[@]} -eq 1 ]];then candidate=${recovery[0]};[[ -f $candidate && ! -L $candidate && -f $candidate.sig && ! -L $candidate.sig && $(stat -c '%u %a' "$candidate") == '0 400' && $(stat -c '%u %a' "$candidate.sig") == '0 400' && $(stat -c '%u %a' "$(dirname "$candidate")") == '0 500' ]]||exit 1;candidate_signer=$(node -p 'require(process.argv[1]).signerKeyId' "$candidate");[[ $candidate_signer =~ ^[A-Za-z0-9@._-]+$ ]];ssh-keygen -Y verify -q -f "$allowed" -I "$candidate_signer" -n steam-top-first-deploy-state -s "$candidate.sig" <"$candidate";candidate_id=$(basename "$(dirname "$candidate")");ln -s "$candidate_id" "$root/.current.$$.tmp";mv -Tf "$root/.current.$$.tmp" "$root/current";sync -f "$root";current=$(realpath "$root/current");prev=$(basename "$current");fi
  read -r old_phase old_nonce _ < <(/opt/steam-top-bootstrap/read-first-deploy-state.sh);[[ $old_nonce == "$nonce" ]];case "$old_phase:$phase" in pending:pending|pending:db-claimed|db-claimed:db-claimed|db-claimed:consumed|consumed:consumed);;*)exit 1;;esac;[[ $old_phase != "$phase" ]]||exit 0
else prev=null;[[ $phase == pending ]]||exit 1;fi
tmp=$(mktemp -d "$root/generations/.stage.XXXXXX");node - "$tmp/payload.json" "$phase" "$nonce" "$host" "$digest" "$receipt_digest" "$prev" "$signer" <<'NODE'
const fs=require("fs"),[out,phase,authorizationNonce,hostId,bootstrapDigest,installReceiptDigest,previousDigest,signerKeyId]=process.argv.slice(2);fs.writeFileSync(out,JSON.stringify({schemaVersion:1,purpose:"steam-top-first-deploy-state",phase,authorizationNonce,hostId,bootstrapDigest,installReceiptDigest,previousDigest:previousDigest==="null"?null:previousDigest,signerKeyId})+"\n",{mode:0o400});
NODE
ssh-keygen -Y sign -q -f "$key" -n steam-top-first-deploy-state "$tmp/payload.json";chmod 0400 "$tmp/payload.json.sig";id=$(sha256sum "$tmp/payload.json"|awk '{print $1}');chmod 0500 "$tmp";sync -f "$tmp";mv "$tmp" "$root/generations/$id";sync -f "$root/generations";ln -s "$id" "$root/.current.$$.tmp";mv -Tf "$root/.current.$$.tmp" "$root/current";sync -f "$root"
