#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 ]]||{ echo "usage: scrub-backups BACKUP_DIR ALLOWED_SIGNERS SIGNER_ID" >&2;exit 2;};script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);status=0
while IFS= read -r set_path;do if "$script_dir/verify-backup-set.sh" "$set_path" "$2" "$3" >/dev/null;then echo "OK ${set_path##*/}";else echo "FAIL ${set_path##*/}" >&2;status=1;fi;done < <(find "$1" -mindepth 1 -maxdepth 1 -type d -name 'steam-top-*.backup' -print|LC_ALL=C sort)
exit "$status"
