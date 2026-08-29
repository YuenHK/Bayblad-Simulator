#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 4 && $4 =~ ^[a-f0-9]{64}$ ]]||exit 1;ready=$1;cutover=$2;signature=$3;nonce=$4;script_path=$(realpath "$0");script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh";backup_trusted_root_deployment "$root" "$script_dir"||exit 1;backup_root_file_mode "$script_path" 555||exit 1
state=${ready%/*};[[ $ready == /* && $state != "$ready" && -d $state && ! -L $state && $(realpath "$state") == "$state" ]]||exit 1;read -r state_owner state_mode < <(stat -c '%u %a' "$state");[[ $state_owner == 0 && $state_mode == 700 ]]||exit 1
final="$ready.finalized.$nonce";[[ ! -L $final ]]||exit 1;if [[ ! -e $final ]];then mkdir -m 700 "$final";fi;[[ -d $final ]]||exit 1;read -r final_owner final_mode < <(stat -c '%u %a' "$final");[[ $final_owner == 0 && $final_mode == 700 ]]||exit 1
for pair in "$ready:promotion-ready" "$ready.sha256:promotion-ready.sha256" "$cutover:cutover-receipt.json" "$signature:cutover-receipt.sig";do source=${pair%%:*};name=${pair#*:};if [[ -f $source ]];then cp -p "$source" "$final/$name.tmp";chmod 440 "$final/$name.tmp";mv "$final/$name.tmp" "$final/$name";fi;[[ -f $final/$name ]]||exit 1;done
if [[ -f $final/COMPLETE ]];then
  [[ ! -L $final/COMPLETE && $(<"$final/COMPLETE") == "$nonce" ]]||exit 1
else
  (set -o noclobber;printf '%s\n' "$nonce" >"$final/COMPLETE")
  chmod 440 "$final/COMPLETE"
fi
rm -f "$ready" "$ready.sha256" "$cutover" "$signature"
