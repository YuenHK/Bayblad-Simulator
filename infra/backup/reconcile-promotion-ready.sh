#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 2 && $2 =~ ^[a-f0-9]{64}$ ]]||exit 1;state=$1;nonce=$2;script_path=$(realpath "$0");script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh"
[[ $script_path =~ ^/opt/steam-top(/releases/[a-f0-9]{64})?/infra/backup/reconcile-promotion-ready\.sh$ && -n ${RUNTIME_INSTALL_MANIFEST_SHA256:-} && -n ${PROMOTE_PGSERVICE:-} && -n ${PGSERVICEFILE:-} && -n ${PGPASSFILE:-} ]]||exit 1;backup_trusted_root_deployment "$root" "$script_dir" "$root/scripts"||exit 1;backup_root_file_mode "$script_path" 555||exit 1;backup_private_file "$PGSERVICEFILE"&&backup_private_file "$PGPASSFILE"||exit 1;backup_reject_libpq_overrides PROMOTE_PGSERVICE||exit 1;"$root/scripts/verify-runtime-install.sh" "$root"||exit 1
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
