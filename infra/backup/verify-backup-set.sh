#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)
[[ $# -eq 4 ]]||exit 1;set_path=$1;allowed=$2;signer=$3;ledger_cli=$4;base=${set_path##*/}
[[ -f $ledger_cli && ! -L $ledger_cli ]]||exit 1
[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ && -d $set_path && ! -L $set_path ]]||exit 1
[[ $(sed -n 's/^set_name=//p' "$set_path/manifest") == "$base" && $(sed -n 's/^backup_id=//p' "$set_path/manifest") =~ ^[0-9a-f-]{36}$ ]]||exit 1
expected=(COMPLETE SIGNED-METADATA VERIFIED VERIFIED.sig checksum.sha256 deletion-ledger.log dump.age manifest signature)
actual=();while IFS= read -r item;do actual+=("$item");done < <(find "$set_path" -mindepth 1 -maxdepth 1 -type f -print|sed 's|.*/||'|LC_ALL=C sort)
[[ ${#actual[@]} -eq ${#expected[@]} ]]||exit 1
for index in "${!expected[@]}";do [[ ${actual[$index]} == "${expected[$index]}" && ! -L $set_path/${actual[$index]} ]]||exit 1;done
[[ $(<"$set_path/COMPLETE") == complete ]]||exit 1
ssh-keygen -Y verify -q -f "$allowed" -I "$signer" -n steam-top-backup -s "$set_path/signature" <"$set_path/SIGNED-METADATA" >/dev/null
ssh-keygen -Y verify -q -f "$allowed" -I "$signer" -n steam-top-backup-verified -s "$set_path/VERIFIED.sig" <"$set_path/VERIFIED" >/dev/null
temporary=$(mktemp "${TMPDIR:-/tmp}/verify-backup.XXXXXX");trap 'rm -f "$temporary"' EXIT;{ cat "$set_path/manifest";cat "$set_path/checksum.sha256";} >"$temporary";cmp -s "$temporary" "$set_path/SIGNED-METADATA"
read -r checksum name extra <"$set_path/checksum.sha256";[[ -z ${extra:-} && $checksum =~ ^[a-f0-9]{64}$ && $name == dump.age ]]
grep -qx "sha256=$checksum" "$set_path/manifest"
if command -v sha256sum >/dev/null 2>&1;then actual_checksum=$(sha256sum "$set_path/dump.age"|awk '{print $1}');else actual_checksum=$(shasum -a 256 "$set_path/dump.age"|awk '{print $1}');fi
[[ $actual_checksum == "$checksum" ]]
"$script_dir/verify-retention-set.sh" "$set_path" "$allowed" "$signer" >/dev/null
ledger_metadata=$(node "$ledger_cli" validate "$set_path/deletion-ledger.log")
ledger_lines=$(sed -n 's/^deletion_ledger_lines=//p' "$set_path/manifest");ledger_sha=$(sed -n 's/^deletion_ledger_sha256=//p' "$set_path/manifest")
[[ $ledger_metadata == *\"lines\":$ledger_lines* && $ledger_metadata == *\"sha256\":\"$ledger_sha\"* ]]
