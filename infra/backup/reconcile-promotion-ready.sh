#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 2 && $2 =~ ^[a-f0-9]{64}$ ]]||exit 1;state=$1;nonce=$2;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P)
[[ -d $state && ! -L $state ]]||exit 1;ready="$state/promotion-ready";[[ ! -e $ready && ! -e $ready.sha256 ]]||exit 1
row=$(PGSERVICE="$PROMOTE_PGSERVICE" psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -AtF '|' -c "select system_identifier,database_name,app_role,restore_target_id,ledger_rows,nonce from restore_control.promotion_outbox where nonce=:'nonce' and state='committed'");IFS='|' read -r system_id database role target rows bound_nonce <<EOF
$row
EOF
[[ $bound_nonce == "$nonce" ]]||exit 1;node "$root/scripts/create-promotion-ready.mjs" "$ready" "$system_id" "$database" "$role" "$target" "$rows" "$nonce";"$root/scripts/portable-sha256.sh" digest "$ready" >"$ready.sha256";chmod 400 "$ready" "$ready.sha256"
