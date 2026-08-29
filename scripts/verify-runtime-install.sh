#!/usr/bin/env bash
set -euo pipefail
runtime_die(){ echo "runtime install refused: $1" >&2;return 1;}
[[ $(id -u) -eq 0 && $# -eq 1 ]]||runtime_die "root and install root required"||exit 1
runtime_root=$(realpath "$1");manifest="$runtime_root/runtime-files.sha256";receipt="$runtime_root/runtime-install-receipt.json"
[[ ( $runtime_root == /opt/steam-top || $runtime_root =~ ^/opt/steam-top/releases/[a-f0-9]{64}$ ) && -f $manifest && ! -L $manifest && -f $receipt && ! -L $receipt ]]||runtime_die "canonical sealed files required"||exit 1
source "$runtime_root/infra/backup/host-trust-guard.sh"
backup_root_file_mode "$manifest" 444&&backup_root_file_mode "$receipt" 444||runtime_die "sealed file root-owned exact mode"||exit 1
[[ ${RUNTIME_INSTALL_MANIFEST_SHA256:-} =~ ^[a-f0-9]{64}$ ]]||runtime_die "RUNTIME_INSTALL_MANIFEST_SHA256 required"||exit 1
actual_manifest=$("$runtime_root/scripts/portable-sha256.sh" digest "$manifest")
[[ $actual_manifest == "$RUNTIME_INSTALL_MANIFEST_SHA256" ]]||runtime_die "external manifest digest mismatch"||exit 1
node - "$receipt" "$actual_manifest" "$runtime_root" <<'NODE'
const fs=require("fs"),r=JSON.parse(fs.readFileSync(process.argv[2]));
if(r.schemaVersion!==1||r.purpose!=="steam-top-runtime-install"||r.installRoot!==process.argv[4]||r.runtimeManifestSha256!==process.argv[3]||!/^[a-f0-9]{40}$/.test(r.commit)||typeof r.sealedAt!=="string")process.exit(1);
NODE
seen='';while IFS=' ' read -r digest required_mode path extra;do
  [[ -z ${extra:-} && $digest =~ ^[a-f0-9]{64}$ && $required_mode =~ ^0(444|555)$ && $path =~ ^[A-Za-z0-9._/-]+$ && $path != /* && $path != *..* ]]||runtime_die "runtime manifest grammar"||exit 1
  case $'\n'$seen$'\n' in *$'\n'"$path"$'\n'*) runtime_die "duplicate runtime path"||exit 1;;esac;seen="${seen}${seen:+$'\n'}$path"
  file="$runtime_root/$path";[[ -f $file && ! -L $file && $(realpath "$file") == "$file" ]]||runtime_die "runtime path unsafe"||exit 1
  backup_root_file_mode "$file" "${required_mode#0}"||runtime_die "runtime file root-owned exact mode"||exit 1
  [[ $("$runtime_root/scripts/portable-sha256.sh" digest "$file") == "$digest" ]]||runtime_die "runtime file digest mismatch"||exit 1
done <"$manifest"
