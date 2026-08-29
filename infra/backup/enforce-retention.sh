#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# -eq 3 ]]||{ echo "usage: enforce-retention BACKUP_DIR ALLOWED_SIGNERS SIGNER_ID" >&2;exit 2;}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);backup_dir=$1;allowed=$2;signer=$3
[[ -d $backup_dir && ! -L $backup_dir ]]||exit 1
quarantine="$backup_dir/.quarantine";mkdir -p "$quarantine";chmod 700 "$quarantine";[[ -d $quarantine && ! -L $quarantine ]]||exit 1
sets=();seen_ids='|';seen_digests='|';moved=0;purged=0
quarantine_set(){ local candidate base destination epoch serial;candidate=$1;base=${candidate##*/};[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ && -d $candidate && ! -L $candidate ]]||return 0;epoch=$(date +%s);serial=$(printf '%06d' "$((($$+RANDOM)%1000000))");destination="$quarantine/q-${base}-${epoch}-${serial}";[[ ! -e $destination ]]||return 1;mv "$candidate" "$destination";moved=$((moved+1));}
while IFS= read -r candidate;do
  base=${candidate##*/};[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ ]]||continue
  if [[ ! -d $candidate || -L $candidate ]];then rm -f -- "$candidate";purged=$((purged+1));continue;fi
  if "$script_dir/verify-retention-set.sh" "$candidate" "$allowed" "$signer" >/dev/null 2>&1;then
    candidate_id=$(sed -n 's/^backup_id=//p' "$candidate/manifest");candidate_digest=$(sed -n 's/^sha256=//p' "$candidate/manifest")
    if [[ $seen_ids != *"|$candidate_id|"* && $seen_digests != *"|$candidate_digest|"* ]];then sets+=("$candidate");seen_ids="${seen_ids}${candidate_id}|";seen_digests="${seen_digests}${candidate_digest}|";else quarantine_set "$candidate";fi
  else quarantine_set "$candidate";fi
done < <(find "$backup_dir" -mindepth 1 -maxdepth 1 -name 'steam-top-*.backup' -print|LC_ALL=C sort)
excess=$((${#sets[@]}-30));if((excess>0));then for((i=0;i<excess;i++));do old=${sets[$i]};[[ ${old##*/} =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ && -d $old && ! -L $old ]]&&rm -rf "$old";done;fi
now=$(date +%s);while IFS= read -r entry;do base=${entry##*/};[[ $base =~ ^q-steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup-[0-9]{10}-[0-9]{6}$ && -d $entry && ! -L $entry ]]||continue;epoch=${base%-*};epoch=${epoch##*-};if((now-epoch>604800));then rm -rf "$entry";purged=$((purged+1));fi;done < <(find "$quarantine" -mindepth 1 -maxdepth 1 -type d -name 'q-steam-top-*.backup-*' -print|LC_ALL=C sort)
while :;do entries=();while IFS= read -r entry;do entries+=("$entry");done < <(find "$quarantine" -mindepth 1 -maxdepth 1 -type d -name 'q-steam-top-*.backup-*' -print|LC_ALL=C sort);bytes=$(du -sk "$quarantine"|awk '{print $1*1024}');((${#entries[@]}<=20&&bytes<=1073741824))&&break;old=${entries[0]:-};[[ -n $old && ${old##*/} =~ ^q-steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup-[0-9]{10}-[0-9]{6}$ && -d $old && ! -L $old ]]||exit 1;rm -rf "$old";purged=$((purged+1));done
echo "backup quarantine: moved=$moved purged=$purged count=${#entries[@]} bytes=$bytes" >&2
