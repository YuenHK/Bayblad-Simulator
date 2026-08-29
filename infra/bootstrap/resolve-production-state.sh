#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 1 && $1 =~ ^[a-f0-9]{64}$ ]]||exit 2
/opt/steam-top-bootstrap/verify-bootstrap.sh;nonce=$1;config=/etc/steam-top-bootstrap/trust.json
mapfile -t values < <(node - "$config" <<'NODE'
const x=require(process.argv[2]);for(const k of ["productionStateDir","productionStateSigningKey"])if(typeof x[k]!=="string"||!x[k].startsWith("/"))process.exit(1);console.log(x.productionStateDir);console.log(x.productionStateSigningKey);
NODE
);root=${values[0]};key=${values[1]};[[ -d $root && ! -L $root && -L $root/current ]]||exit 1;generation=$(realpath "$root/current");[[ $generation == "$root/generations/"* && -d $generation && ! -L $generation ]]||exit 1
state="$generation/payload.json";state_sig="$state.sig";activation_root="$root/activations/$nonce";[[ -d $activation_root && ! -L $activation_root && -L $activation_root/current ]]||exit 1;activation_generation=$(realpath "$activation_root/current");[[ $activation_generation == "$activation_root/"* && -d $activation_generation && ! -L $activation_generation ]]||exit 1;activation="$activation_generation/payload.json";activation_sig="$activation.sig"
for file in "$state" "$state_sig" "$activation" "$activation_sig";do [[ -f $file && ! -L $file ]]||exit 1;done;allowed=$(mktemp);trap 'rm -f "$allowed"' EXIT;printf 'state %s\n' "$(ssh-keygen -y -f "$key")" >"$allowed";ssh-keygen -Y verify -q -f "$allowed" -I state -n steam-top-protected-deployment-state -s "$state_sig" <"$state";ssh-keygen -Y verify -q -f "$allowed" -I state -n steam-top-production-activation -s "$activation_sig" <"$activation"
node - "$state" "$activation" "$nonce" <<'NODE'
const fs=require("fs"),crypto=require("crypto"),s=require(process.argv[2]),a=require(process.argv[3]),nonce=process.argv[4],digest=crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex");if(s.schemaVersion!==4||s.purpose!=="production"||s.nonce!==nonce||a.schemaVersion!==1||a.purpose!=="production-activation-receipt"||a.nonce!==nonce||a.deploymentId!==s.deploymentId||a.stateDigest!==digest||a.activatedAt!==s.activatedAt)process.exit(1);
NODE
printf 'STATE-BEGIN %s\n' "$nonce";base64 <"$state";printf 'STATE-SIGNATURE\n';base64 <"$state_sig";printf 'ACTIVATION-RECEIPT\n';base64 <"$activation";printf 'ACTIVATION-SIGNATURE\n';base64 <"$activation_sig";printf 'STATE-END %s\n' "$nonce"
