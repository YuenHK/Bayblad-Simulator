#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover finalization refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 1 && ${CUTOVER_CONFIRM:-} == DATABASE_URL_CUTOVER_SUCCEEDED ]]||die "root, ready path and confirmation required"
ready=$1;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE;do [[ -n ${!name:-} ]]||die "$name required";done
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq overrides";backup_private_file "$PGSERVICEFILE"||die "service file";backup_private_file "$PGPASSFILE"||die "pass file";backup_trusted_root_deployment "$root" "$script_dir" "$root/apps/server/dist/admin"||die "host trust"
[[ $ready == /* && -f $ready && ! -L $ready && -f $ready.sha256 && ! -L $ready.sha256 ]]||die "ready files unsafe";backup_root_file_mode "$ready" 400||die "ready mode";backup_root_file_mode "$ready.sha256" 400||die "ready digest mode";[[ $("$root/scripts/portable-sha256.sh" digest "$ready") == "$(<"$ready.sha256")" ]]||die "ready digest mismatch"
readarray -t values < <(node -e 'const x=require(process.argv[1]);if(x.schemaVersion!==1)process.exit(1);for(const k of ["systemIdentifier","database","appRole","restoreTargetId"])console.log(x[k])' "$ready");[[ ${#values[@]} -eq 4 ]]||die "ready schema";system_id=${values[0]};database=${values[1]};role=${values[2]};target_id=${values[3]};[[ $database =~ ^[a-z_][a-z0-9_]{0,62}$ && $role =~ ^[a-z_][a-z0-9_]{0,62}$ ]]||die "identity"
export PGSERVICE=$PROMOTE_PGSERVICE
actual=$(psql -X -v ON_ERROR_STOP=1 -v target_id="$target_id" -v role="$role" -AtF '|' -c "select (select system_identifier from pg_control_system()),current_database(),exists(select 1 from restore_control.deployment_environment where singleton and environment='production' and not restore_allowed and restore_target_id=:'target_id'::uuid),has_database_privilege('public',current_database(),'connect'),has_database_privilege(:'role',current_database(),'connect')")
[[ $actual == "$system_id|$database|t|f|f" ]]||die "database state changed or ACL already open"
psql -X -v ON_ERROR_STOP=1 -v role="$role" -v target_id="$target_id" <<'SQL'
begin;
select pg_advisory_xact_lock(1937002751);
select format('grant connect on database %I to %I',current_database(),:'role') \gexec
create table if not exists restore_control.promotion_audit(id bigserial primary key,restore_target_id uuid not null,app_role text not null,finalized_at timestamptz not null default clock_timestamp());
insert into restore_control.promotion_audit(restore_target_id,app_role) values (:'target_id'::uuid,:'role');
commit;
SQL
stamp=$(date -u +%Y%m%dT%H%M%SZ);receipt="$ready.finalized.$stamp";[[ ! -e $receipt ]]||die "receipt exists";mv "$ready" "$receipt";mv "$ready.sha256" "$receipt.sha256";chmod 440 "$receipt" "$receipt.sha256";echo "cutover finalized; receipt $receipt"
