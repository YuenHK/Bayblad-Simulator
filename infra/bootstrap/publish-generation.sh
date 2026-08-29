#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]]||exit 2
staging=$1;final=$2;parent=$(dirname "$final")
[[ -d $staging && ! -L $staging && -d $parent && ! -L $parent ]]||exit 1
lock="$parent/.publish.lock";if [[ ! -e $lock ]];then install -o root -g root -m 0600 /dev/null "$lock";fi;[[ -f $lock && ! -L $lock ]]||exit 1;read -r owner mode < <(stat -c '%u %a' "$lock");[[ $owner == 0 && $mode == 600 ]]||exit 1;exec 8<>"$lock";flock 8
for file in payload.json payload.json.sig;do [[ -f $staging/$file && ! -L $staging/$file ]]||exit 1;chmod 0400 "$staging/$file";done
chmod 0500 "$staging";sync -f "$staging/payload.json" "$staging/payload.json.sig" "$staging"
if [[ -e $final ]];then [[ -d $final && ! -L $final ]]||exit 1;read -r owner mode < <(stat -c '%u %a' "$final");[[ $owner == 0 && $mode == 500 ]]||exit 1;for file in payload.json payload.json.sig;do read -r owner mode < <(stat -c '%u %a' "$final/$file");[[ $owner == 0 && $mode == 400 ]]||exit 1;cmp -s "$staging/$file" "$final/$file"||exit 1;done;rm -rf "$staging";else mv "$staging" "$final";fi
sync -f "$parent"
