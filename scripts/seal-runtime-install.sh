#!/usr/bin/env bash
set -euo pipefail
die(){ echo "runtime install seal refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 3 ]]||die "root and source manifest/expected digest/commit required"
source_manifest=$1;expected=$2;commit=$3;root=$(CDPATH= cd -- "$(dirname -- "$(realpath "$0")")/.."&&pwd -P)
[[ $root == /opt/steam-top && -f $source_manifest && ! -L $source_manifest && $expected =~ ^[a-f0-9]{64}$ && $commit =~ ^[a-f0-9]{40}$ ]]||die "canonical inputs"
source "$root/infra/backup/host-trust-guard.sh";[[ $("$root/scripts/portable-sha256.sh" digest "$source_manifest") == "$expected" ]]||die "externally verified manifest digest"
while IFS=' ' read -r digest mode path extra;do
  [[ -z ${extra:-} && $digest =~ ^[a-f0-9]{64}$ && $mode =~ ^0(444|555)$ && $path =~ ^[A-Za-z0-9._/-]+$ && $path != /* && $path != *..* ]]||die "manifest grammar"
  file="$root/$path";[[ -f $file && ! -L $file && $(realpath "$file") == "$file" ]]||die "runtime file unsafe"
  [[ $("$root/scripts/portable-sha256.sh" digest "$file") == "$digest" ]]||die "runtime digest mismatch"
  chown root:root "$file";chmod "$mode" "$file"
done <"$source_manifest"
install -o root -g root -m 0444 "$source_manifest" "$root/runtime-files.sha256"
tmp=$(mktemp "$root/.runtime-install-receipt.XXXXXX");trap 'rm -f "$tmp"' EXIT
node - "$expected" "$commit" "$tmp" <<'NODE'
const fs=require("fs");fs.writeFileSync(process.argv[4],JSON.stringify({schemaVersion:1,purpose:"steam-top-runtime-install",installRoot:"/opt/steam-top",runtimeManifestSha256:process.argv[2],commit:process.argv[3],sealedAt:new Date().toISOString()})+"\n",{mode:0o444});
NODE
chown root:root "$tmp";chmod 0444 "$tmp";mv "$tmp" "$root/runtime-install-receipt.json";trap - EXIT
RUNTIME_INSTALL_MANIFEST_SHA256=$expected "$root/scripts/verify-runtime-install.sh" "$root"
