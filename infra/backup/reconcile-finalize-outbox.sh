#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 4 && $4 =~ ^[a-f0-9]{64}$ ]]||exit 1;ready=$1;cutover=$2;signature=$3;nonce=$4;final="$ready.finalized.$nonce";mkdir -p "$final";chmod 700 "$final"
for pair in "$ready:promotion-ready" "$ready.sha256:promotion-ready.sha256" "$cutover:cutover-receipt.json" "$signature:cutover-receipt.sig";do source=${pair%%:*};name=${pair#*:};if [[ -f $source ]];then cp -p "$source" "$final/$name.tmp";chmod 440 "$final/$name.tmp";mv "$final/$name.tmp" "$final/$name";fi;[[ -f $final/$name ]]||exit 1;done
if [[ -f $final/COMPLETE ]];then
  [[ ! -L $final/COMPLETE && $(<"$final/COMPLETE") == "$nonce" ]]||exit 1
else
  (set -o noclobber;printf '%s\n' "$nonce" >"$final/COMPLETE")
  chmod 440 "$final/COMPLETE"
fi
rm -f "$ready" "$ready.sha256" "$cutover" "$signature"
