#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 2 && $2 =~ ^[a-f0-9]{64}$ ]]||exit 1;state=$1;nonce=$2;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P)
[[ -d $state && ! -L $state && $(realpath "$state") == "$state" ]]||exit 1;read -r owner mode < <(stat -c '%u %a' "$state");[[ $owner == 0 && $mode == 700 ]]||exit 1;ready="$state/promotion-ready";tmp="$state/.promotion-ready.$nonce.$$";trap 'rm -f "$tmp" "$tmp.sha256"' EXIT
row=$(PGSERVICE="$PROMOTE_PGSERVICE" psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -AtF '|' -c "select system_identifier,database_name,app_role,restore_target_id,ledger_rows,nonce from restore_control.promotion_outbox where nonce=:'nonce' and state='committed'");IFS='|' read -r system_id database role target rows bound_nonce <<EOF
$row
EOF
[[ $bound_nonce == "$nonce" ]]||exit 1;node "$root/scripts/create-promotion-ready.mjs" "$tmp" "$system_id" "$database" "$role" "$target" "$rows" "$nonce";"$root/scripts/portable-sha256.sh" digest "$tmp" >"$tmp.sha256";chmod 400 "$tmp" "$tmp.sha256"
if [[ -e $ready || -e $ready.sha256 ]];then
  [[ -f $ready && ! -L $ready && -f $ready.sha256 && ! -L $ready.sha256 && $("$root/scripts/portable-sha256.sh" digest "$ready") == "$(<"$ready.sha256")" ]]||exit 1
  node - "$ready" "$system_id" "$database" "$role" "$target" "$rows" "$nonce" <<'NODE'
const r=require(process.argv[2]);if(r.schemaVersion!==2||r.systemIdentifier!==process.argv[3]||r.database!==process.argv[4]||r.appRole!==process.argv[5]||r.restoreTargetId!==process.argv[6]||r.ledgerRows!==Number(process.argv[7])||r.promotionNonce!==process.argv[8]||r.marker?.environment!=="production"||r.marker?.restoreAllowed!==false)process.exit(1);
NODE
  exit 0
fi
mv "$tmp" "$ready";mv "$tmp.sha256" "$ready.sha256";trap - EXIT
