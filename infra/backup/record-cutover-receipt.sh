#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover receipt refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 2 ]]||die "root and ready/receipt paths required"
ready=$1;receipt=$2;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in CUTOVER_DATABASE_URL_FILE PUBLIC_ORIGIN DEPLOYMENT_MANIFEST_SHA256 CUTOVER_NONCE CUTOVER_SIGNING_KEY PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE ADMIN_SMOKE_SECRET_FILE;do [[ -n ${!name:-} ]]||die "$name required";done
backup_trusted_root_deployment "$root" "$script_dir" "$root/scripts"||die "host trust";for private in "$CUTOVER_SIGNING_KEY" "$CUTOVER_DATABASE_URL_FILE" "$PGSERVICEFILE" "$PGPASSFILE" "$ADMIN_SMOKE_SECRET_FILE";do backup_private_file "$private"||die "private file trust";done
[[ $ready == /* && $receipt == /* && -f $ready && ! -L $ready && ! -e $receipt && ! -e $receipt.sig ]]||die "unsafe paths";backup_root_file_mode "$ready" 400||die "ready trust"
probe="$receipt.probe.tmp";PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$CUTOVER_NONCE" <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);create table if not exists restore_control.deployment_probe(nonce text primary key,restore_target_id uuid not null,system_identifier text not null,created_at timestamptz not null default clock_timestamp(),consumed_at timestamptz);insert into restore_control.deployment_probe(nonce,restore_target_id,system_identifier)select :'nonce',restore_target_id,(select system_identifier::text from pg_control_system()) from restore_control.deployment_environment where singleton;commit;
SQL
ADMIN_SMOKE_SECRET_FILE="$ADMIN_SMOKE_SECRET_FILE" PRODUCTION_SMOKE_PROBE_OUTPUT="$probe" "$root/scripts/production-smoke.sh" "$PUBLIC_ORIGIN" "$CUTOVER_NONCE";node "$root/scripts/create-cutover-receipt.mjs" "$ready" "$CUTOVER_DATABASE_URL_FILE" "$PUBLIC_ORIGIN" "$DEPLOYMENT_MANIFEST_SHA256" "$CUTOVER_NONCE" "$probe" "$receipt";rm -f "$probe"
ssh-keygen -Y sign -q -f "$CUTOVER_SIGNING_KEY" -n steam-top-cutover "$receipt";chmod 400 "$receipt" "$receipt.sig"
