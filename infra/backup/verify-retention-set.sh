#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 ]]||exit 1;set_path=$1;allowed=$2;signer=$3;base=${set_path##*/}
[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ && -d $set_path && ! -L $set_path ]]||exit 1
expected=(COMPLETE SIGNED-METADATA VERIFIED VERIFIED.sig checksum.sha256 deletion-ledger.log dump.age manifest signature);actual=();while IFS= read -r item;do actual+=("$item");done < <(find "$set_path" -mindepth 1 -maxdepth 1 -type f -print|sed 's|.*/||'|LC_ALL=C sort);[[ ${#actual[@]} -eq ${#expected[@]} ]]||exit 1
for index in "${!expected[@]}";do [[ ${actual[$index]} == "${expected[$index]}" && ! -L $set_path/${actual[$index]} ]]||exit 1;done
ssh-keygen -Y verify -q -f "$allowed" -I "$signer" -n steam-top-backup -s "$set_path/signature" <"$set_path/SIGNED-METADATA" >/dev/null
ssh-keygen -Y verify -q -f "$allowed" -I "$signer" -n steam-top-backup-verified -s "$set_path/VERIFIED.sig" <"$set_path/VERIFIED" >/dev/null
if command -v sha256sum >/dev/null 2>&1;then digest=$(sha256sum "$set_path/manifest"|awk '{print $1}');else digest=$(shasum -a 256 "$set_path/manifest"|awk '{print $1}');fi
[[ $(<"$set_path/VERIFIED") == "manifest_sha256=$digest" ]]
