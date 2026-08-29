#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 1 && $1 =~ ^[a-f0-9]{64}$ ]]||exit 2
/opt/steam-top-bootstrap/verify-bootstrap.sh;nonce=$1;config=/etc/steam-top-bootstrap/trust.json
read -r outbox allowed < <(node - "$config" <<'NODE'
const x=require(process.argv[2]);if(!x.hostReceiptOutbox?.startsWith("/")||!x.evidenceAllowedSigners?.startsWith("/"))process.exit(1);console.log(x.hostReceiptOutbox,x.evidenceAllowedSigners)
NODE
)
root="$outbox/authorization-evidence/$nonce";[[ -d $root && ! -L $root && -L $root/current ]]||exit 1
read -r owner mode < <(stat -c '%u %a' "$root");[[ $owner == 0 && $mode == 700 ]]||exit 1
generation=$(realpath "$root/current");[[ $generation == "$root/"* && -d $generation && ! -L $generation ]]||exit 1;payload="$generation/payload.json";signature="$payload.sig"
for entry in "$generation" "$payload" "$signature";do [[ ! -L $entry ]]||exit 1;done
read -r owner mode < <(stat -c '%u %a' "$generation");[[ $owner == 0 && $mode == 500 ]]||exit 1
for file in "$payload" "$signature";do read -r owner mode < <(stat -c '%u %a' "$file");[[ $owner == 0 && $mode == 400 ]]||exit 1;done
digest=$(sha256sum "$payload"|awk '{print $1}');[[ $(basename "$generation") == "$digest" ]]||exit 1
read -r owner mode < <(stat -c '%u %a' "$allowed");[[ -f $allowed && ! -L $allowed && $owner == 0 && $mode == 444 ]]||exit 1;key_id=$(node -p 'require(process.argv[1]).signerKeyId' "$payload");ssh-keygen -Y verify -q -f "$allowed" -I "$key_id" -n steam-top-deployment-authorization-evidence -s "$signature" <"$payload"||exit 1
node - "$payload" "$nonce" <<'NODE'
const e=require(process.argv[2]);if(e.schemaVersion!==1||e.purpose!=="steam-top-deployment-authorization-evidence"||e.nonce!==process.argv[3]||e.authorization?.nonce!==e.nonce||e.authorization?.deploymentId!==e.deploymentId)process.exit(1)
NODE
printf 'RECEIPT-BEGIN %s\n' "$nonce";base64 <"$payload";printf 'RECEIPT-SIGNATURE\n';base64 <"$signature";printf 'RECEIPT-END %s\n' "$nonce"
