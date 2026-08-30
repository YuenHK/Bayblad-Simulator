#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 1 ]]||exit 2;incident_dir=$1;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE;do [[ -n ${!name:-} ]]||exit 1;done;backup_reject_libpq_overrides PROMOTE_PGSERVICE||exit 1;install -d -o root -g root -m 0700 "$incident_dir"
rows=$(PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -AtF '|' -c "select nonce,app_role,restore_target_id,system_identifier,database_name,ledger_rows,ready_sha256,preflight_sha256,lease_generation from restore_control.finalize_outbox where state in ('connect-granted-pending-smoke','smoke-observed') and deadline_at < clock_timestamp() order by deadline_at")
[[ -n $rows ]]||exit 0
while IFS='|' read -r nonce role target system database ledger ready_sha preflight_sha generation;do
  [[ $nonce =~ ^[a-f0-9]{64}$ && $role =~ ^[a-z_][a-z0-9_]{0,62}$ && $database =~ ^[a-z_][a-z0-9_]{0,62}$ && $ready_sha =~ ^[a-f0-9]{64}$ && $preflight_sha =~ ^[a-f0-9]{64}$ ]]||exit 1
  result=$(PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -v role="$role" -v target="$target" -v system="$system" -v database="$database" -v ledger="$ledger" -v generation="$generation" -v ready_sha="$ready_sha" -v preflight_sha="$preflight_sha" -At <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);
select case when exists(select 1 from restore_control.finalize_outbox where nonce=:'nonce' and state in ('connect-granted-pending-smoke','smoke-observed') and deadline_at<clock_timestamp() and lease_generation=:'generation'::bigint and app_role=:'role' and restore_target_id=:'target'::uuid and system_identifier=:'system' and database_name=:'database' and ledger_rows=:'ledger'::bigint and ready_sha256=:'ready_sha' and preflight_sha256=:'preflight_sha' for update) and current_database()=:'database' and (select system_identifier::text from pg_control_system())=:'system' and exists(select 1 from restore_control.deployment_environment where singleton and environment='production' and not restore_allowed and restore_target_id=:'target'::uuid) and (select count(*) from deletion_audit)=:'ledger'::bigint then 1 else 1/0 end;
select format('revoke connect on database %I from %I',current_database(),:'role') \gexec
select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename=:'role' and pid<>pg_backend_pid();update restore_control.finalize_outbox set state='aborted',aborted_at=clock_timestamp(),deadline_at=null where nonce=:'nonce' and state in ('connect-granted-pending-smoke','smoke-observed') and lease_generation=:'generation'::bigint returning state;commit;
SQL
  );[[ $result == *aborted* ]]||exit 1;[[ $(PGSERVICE=$PROMOTE_PGSERVICE psql -X -Atqc "select (not has_database_privilege('$role',current_database(),'connect')) and not exists(select 1 from pg_stat_activity where datname=current_database() and usename='$role')") == t ]]||exit 1
  incident="$incident_dir/CUTOVER-ABORTED.$nonce";printf 'nonce=%s\nstate=aborted\nlease_generation=%s\nready_sha256=%s\npreflight_sha256=%s\n' "$nonce" "$generation" "$ready_sha" "$preflight_sha" >"$incident";chmod 600 "$incident"
done <<<"$rows"
