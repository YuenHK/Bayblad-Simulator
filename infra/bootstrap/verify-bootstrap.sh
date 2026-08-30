#!/usr/bin/env bash
set -euo pipefail
die(){ echo "bootstrap trust refused: $1" >&2;return 1;}
[[ $(id -u) -eq 0 ]]||die "root required"||exit 1
root=/opt/steam-top-bootstrap;config=/etc/steam-top-bootstrap/trust.json;manifest="$root/bootstrap-files.sha256"
for dir in "$root" /etc/steam-top-bootstrap;do [[ -d $dir && ! -L $dir ]]||die "canonical directory"||exit 1;read -r owner mode < <(stat -c '%u %a' "$dir");[[ $owner == 0 && $mode == 555 ]]||die "root directory exact mode"||exit 1;done
for file in "$config" "$manifest" /etc/steam-top-bootstrap/policy-signer-manifest.json;do [[ -f $file && ! -L $file ]]||die "sealed file"||exit 1;read -r owner mode < <(stat -c '%u %a' "$file");[[ $owner == 0 && $mode == 400 ]]||die "sealed root-owned exact mode"||exit 1;done
sha(){ if command -v sha256sum >/dev/null;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;}
expected=$(node -e 'const x=require(process.argv[1]);if(x.schemaVersion!==1||x.purpose!=="steam-top-bootstrap-trust"||!/^[a-f0-9]{64}$/.test(x.bootstrapSha256)||!/^[a-f0-9]{40}$/.test(x.workflowSha)||!x.workflowRef.startsWith("refs/heads/")||!/^[-\w.]+\/[-\w.]+$/.test(x.repository))process.exit(1);process.stdout.write(x.bootstrapSha256)' "$config")||die "trust config"
[[ $(sha "$manifest") == "$expected" ]]||die "bootstrapSha256 mismatch"||exit 1
while IFS=' ' read -r digest mode path extra;do [[ -z ${extra:-} && $digest =~ ^[a-f0-9]{64}$ && $mode =~ ^0(444|555)$ && $path =~ ^[A-Za-z0-9._/-]+$ && $path != *..* ]]||die "manifest grammar"||exit 1;file="$root/$path";[[ -f $file && ! -L $file && $(realpath "$file") == "$file" ]]||die "bootstrap file unsafe"||exit 1;read -r owner actual < <(stat -c '%u %a' "$file");[[ $owner == 0 && $actual == "${mode#0}" && $(sha "$file") == "$digest" ]]||die "bootstrap file root-owned exact mode or digest"||exit 1;done <"$manifest"
/opt/steam-top-bootstrap/invoke-production-policy-signer.py --verify-install >/dev/null||die "installed production policy signer"||exit 1
