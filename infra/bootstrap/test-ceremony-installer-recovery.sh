#!/usr/bin/env bash
set -euo pipefail
[[ ${CI:-} == true && $(id -u) -eq 0 && $# -ge 2 && $(uname -s) == Linux ]]||exit 2
installer=$1;shift
[[ -f $installer && ! -L $installer ]]||exit 2
root=/opt/steam-top-policy-ceremony
manifest=/etc/steam-top-bootstrap/policy-ceremony-manifest.json
[[ -d $root && ! -L $root && -f $manifest && ! -L $manifest ]]||exit 1
safe=$root/.stage.ABC123
foreign=$root/.stage.XYZ789
cleanup(){ rm -rf -- "$safe" "$foreign"; }
trap cleanup EXIT

install -d -o root -g root -m 0700 "$safe"
install -o root -g root -m 0444 /opt/steam-top-bootstrap/verify-production-policy-anchor.mjs "$safe/verify-production-policy-anchor.mjs"
"$installer" "$@"
[[ ! -e $safe ]]

install -d -o root -g root -m 0700 "$foreign"
install -o root -g root -m 0444 /dev/null "$foreign/foreign"
if "$installer" "$@";then
  echo "installer accepted a foreign ceremony stage" >&2
  exit 1
fi
[[ -f $foreign/foreign && ! -L $foreign/foreign ]]
rm -rf -- "$foreign"

node - "$manifest" "$root" <<'NODE'
const fs=require("fs"),path=require("path"),[manifestPath,root]=process.argv.slice(2),value=require(manifestPath);
if(!/^[a-f0-9]{64}$/.test(value.generationDigest)||value.generationPath!==`${root}/${value.generationDigest}`||!fs.statSync(value.generationPath).isDirectory())process.exit(1);
const generations=fs.readdirSync(root).filter(name=>/^[a-f0-9]{64}$/.test(name));
if(generations.length!==1||generations[0]!==value.generationDigest)process.exit(1);
NODE
/opt/steam-top-bootstrap/invoke-production-policy-ceremony.py --verify-install >/dev/null
