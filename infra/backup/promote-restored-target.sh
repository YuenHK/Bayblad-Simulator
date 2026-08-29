#!/usr/bin/env bash
set -euo pipefail
die(){ echo "promotion refused: $1" >&2;exit 1;}
[[ $# -eq 1 ]]||die "pass exactly one verified backup set"
source_set=$1;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)
# shellcheck source=host-trust-guard.sh
source "$script_dir/host-trust-guard.sh"
[[ $(id -u) -eq 0 ]]||die "promotion must run as root"
for name in PROMOTE_PGSERVICE PROMOTE_MAINTENANCE_PGSERVICE PROMOTE_APP_ROLE PROMOTE_STATE_DIR PGSERVICEFILE PGPASSFILE PROMOTE_CONFIRM_DATABASE RESTORE_ALLOWED_TARGET_ID DELETION_LEDGER_FILE BACKUP_ALLOWED_SIGNERS_FILE BACKUP_SIGNER_ID PROMOTE_CONFIRM APP_UID PROMOTION_NONCE;do [[ -n ${!name:-} ]]||die "$name is required";done
[[ $PROMOTION_NONCE =~ ^[a-f0-9]{64}$ ]]||die "promotion nonce invalid"
[[ $PROMOTE_APP_ROLE =~ ^[a-z_][a-z0-9_]{0,62}$ ]]||die "application role invalid"
[[ $PROMOTE_CONFIRM_DATABASE =~ ^[a-z_][a-z0-9_]{0,62}$ ]]||die "database name invalid"
[[ $PROMOTE_STATE_DIR == /* && -d $PROMOTE_STATE_DIR && ! -L $PROMOTE_STATE_DIR ]]||die "state directory invalid"
read -r state_owner state_mode < <(stat -c '%u %a' "$PROMOTE_STATE_DIR" 2>/dev/null||stat -f '%u %Lp' "$PROMOTE_STATE_DIR");[[ $state_owner == 0 && $state_mode == 700 ]]||die "state directory must be root-owned 0700"
[[ $PROMOTE_CONFIRM == PROMOTE_VERIFIED_RESTORE_TO_PRODUCTION && ${APP_ENV:-} != production && ${NODE_ENV:-} != production && -z ${DATABASE_URL:-} && -z ${RESTORE_DATABASE_URL:-} ]]||die "promotion confirmation/environment guard"
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq trust boundary"
for private in "$PGSERVICEFILE" "$PGPASSFILE" "$BACKUP_ALLOWED_SIGNERS_FILE";do backup_private_file "$private"||die "private file trust boundary";done
[[ -f $DELETION_LEDGER_FILE && ! -L $DELETION_LEDGER_FILE ]]||die "ledger unsafe";read -r ledger_owner ledger_mode < <(stat -c '%u %a' "$DELETION_LEDGER_FILE" 2>/dev/null||stat -f '%u %Lp' "$DELETION_LEDGER_FILE");[[ $APP_UID =~ ^[1-9][0-9]*$ && $ledger_owner == "$APP_UID" && $ledger_mode == 600 ]]||die "live ledger must remain configured APP_UID-owned 0600"
ledger_cli="$script_dir/../../apps/server/dist/admin/deletion-ledger-cli.js";deployment_root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P)
backup_trusted_root_deployment "$deployment_root" "$script_dir" "${ledger_cli%/*}"||die "deployment trust boundary"
backup_trusted_ledger_cli "$deployment_root" "$script_dir" "$ledger_cli"||die "ledger CLI trust boundary"
for stale in "$PROMOTE_STATE_DIR"/promotion-ready "$PROMOTE_STATE_DIR"/promotion-ready.sha256 "$PROMOTE_STATE_DIR"/.promotion-reserved "$PROMOTE_STATE_DIR"/RECOVERY-REQUIRED.*;do [[ ! -e $stale ]]||die "unconsumed promotion state exists";done
reserve="$PROMOTE_STATE_DIR/.promotion-reserved";(set -o noclobber;umask 077;printf '%s\n' "$$" >"$reserve") 2>/dev/null||die "promotion already reserved";chmod 600 "$reserve"
ready_dir=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-promotion.XXXXXX");chmod 700 "$ready_dir";guard_pid=""
restore_allow(){ local allowed=true;[[ -f $ready_dir/original-allow && $(<"$ready_dir/original-allow") == f ]]&&allowed=false;PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v target_database="$PROMOTE_CONFIRM_DATABASE" -v allowed="$allowed" -c "select format('alter database %I allow_connections %s', :'target_database', :'allowed')" -At | PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 >/dev/null;}
cleanup(){ local original=$1 recovery=0 committed=f table_exists=f;if [[ -f $ready_dir/connections-disabled ]];then restore_allow||recovery=70;fi;if [[ $original -ne 0 && $recovery -eq 0 ]];then table_exists=$(PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -Atqc "select to_regclass('restore_control.promotion_outbox') is not null")||recovery=70;if [[ $table_exists == t ]];then committed=$(PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$PROMOTION_NONCE" -Atqc "select exists(select 1 from restore_control.promotion_outbox where nonce=:'nonce' and state='committed')")||recovery=70;fi;[[ $committed == t ]]&&recovery=70;fi;if [[ -n $guard_pid ]];then kill "$guard_pid" >/dev/null 2>&1||true;wait "$guard_pid" >/dev/null 2>&1||true;fi;if [[ $recovery -ne 0 ]];then umask 077;incident="$PROMOTE_STATE_DIR/RECOVERY-REQUIRED.$(date -u +%Y%m%dT%H%M%SZ).$$";printf 'incident_path=%s\ndatabase=%s\nsystem_identifier=%s\ntime_utc=%s\nphase=%s\nmanual_action=keep application traffic stopped; reconcile authoritative promotion_outbox\n' "$incident" "$PROMOTE_CONFIRM_DATABASE" "${target_system:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$([[ $committed == t ]]&&echo post-commit||echo pre-commit)" >"$incident";chmod 600 "$incident";return "$recovery";fi;rm -f "$reserve";rm -rf "$ready_dir";return "$original";};trap 'rc=$?;trap - EXIT;cleanup "$rc";exit $?' EXIT;trap 'exit 130' INT TERM
node "$ledger_cli" hold-lock "$DELETION_LEDGER_FILE" "$ready_dir/ready" & guard_pid=$!
for _ in {1..100};do [[ -f $ready_dir/ready && $(<"$ready_dir/ready") == ready ]]&&break;kill -0 "$guard_pid" >/dev/null 2>&1||die "ledger guard exited";sleep 0.1;done
[[ -f $ready_dir/ready && $(<"$ready_dir/ready") == ready ]]||die "ledger guard timeout"
# Bind every later decision to a private snapshot copied only after the ledger lock.
base=${source_set##*/};[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ && -d $source_set && ! -L $source_set ]]||die "source backup unsafe"
snapshot="$ready_dir/$base";mkdir "$snapshot";chmod 700 "$snapshot"
for file in COMPLETE SIGNED-METADATA VERIFIED VERIFIED.sig checksum.sha256 deletion-ledger.log dump.age manifest signature;do [[ -f $source_set/$file && ! -L $source_set/$file ]]||die "source backup component unsafe";cp -p "$source_set/$file" "$snapshot/$file";done
"$script_dir/verify-backup-set.sh" "$snapshot" "$BACKUP_ALLOWED_SIGNERS_FILE" "$BACKUP_SIGNER_ID" "$ledger_cli" >/dev/null||die "signed immutable snapshot verification failed"
"$script_dir/verify-rollback-preflight.sh" "$snapshot" "$DELETION_LEDGER_FILE" >/dev/null
expected_rows=$(sed -n 's/^verification_rows=//p' "$snapshot/manifest");[[ $expected_rows =~ ^[0-9]+$ ]]||die "verification row metadata invalid"
export PGSERVICE=$PROMOTE_PGSERVICE
target=$(psql -X -v ON_ERROR_STOP=1 -Atqc 'select current_database()');[[ $target == "$PROMOTE_CONFIRM_DATABASE" ]]||die "target database confirmation mismatch"
target_system=$(psql -X -v ON_ERROR_STOP=1 -Atqc 'select system_identifier from pg_control_system()')
maintenance_check=$(PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v target_database="$PROMOTE_CONFIRM_DATABASE" -AtF '|' -c "select current_database()<>:'target_database',exists(select 1 from pg_database where datname=:'target_database'),(select system_identifier from pg_control_system()),(select rolsuper or pg_has_role(current_user,'pg_signal_backend','member') from pg_roles where rolname=current_user)")
IFS='|' read -r maintenance_separate target_exists maintenance_system signal_privilege <<<"$maintenance_check"
[[ $maintenance_separate == t && $target_exists == t && $maintenance_system == "$target_system" && $signal_privilege == t ]]||die "maintenance recovery preflight failed"
PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v db="$PROMOTE_CONFIRM_DATABASE" -Atc "select datallowconn from pg_database where datname=:'db'" >"$ready_dir/original-allow";chmod 400 "$ready_dir/original-allow"
touch "$ready_dir/connections-disabled";export ready_dir
psql -X -v ON_ERROR_STOP=1 -v target_id="$RESTORE_ALLOWED_TARGET_ID" -v expected_rows="$expected_rows" -v app_role="$PROMOTE_APP_ROLE" -v nonce="$PROMOTION_NONCE" <<'SQL'
select format('alter database %I allow_connections false',current_database()) \gexec
select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid();
select not exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()) as isolated_ok \gset
\if :isolated_ok
begin;
select pg_advisory_xact_lock(1937002751);
select exists (select 1 from restore_control.deployment_environment where singleton=true and environment in ('staging','test') and restore_allowed=true and restore_target_id=:'target_id'::uuid) as marker_ok \gset
select (select count(*) from deletion_audit)=:'expected_rows'::bigint as ledger_ok \gset
\if :marker_ok
\if :ledger_ok
select format('revoke connect on database %I from public',current_database()) \gexec
select format('revoke connect on database %I from %I',current_database(),:'app_role') \gexec
set local steam_top.configure_restore_target='RESTORE_NONPRODUCTION_DATA';
update restore_control.deployment_environment set environment='production',restore_allowed=false where singleton=true;
create table if not exists restore_control.promotion_outbox(nonce text primary key,restore_target_id uuid not null,system_identifier text not null,database_name text not null,app_role text not null,ledger_rows bigint not null,state text not null check(state='committed'),created_at timestamptz not null default clock_timestamp());
insert into restore_control.promotion_outbox(nonce,restore_target_id,system_identifier,database_name,app_role,ledger_rows,state) values(:'nonce',:'target_id'::uuid,(select system_identifier::text from pg_control_system()),current_database(),:'app_role',:'expected_rows'::bigint,'committed') on conflict(nonce) do nothing;
select not has_database_privilege('public',current_database(),'connect') and not has_database_privilege(:'app_role',current_database(),'connect') as acl_closed \gset
\if :acl_closed
\else
\quit 5
\endif
select exists(select 1 from restore_control.deployment_environment where singleton=true and environment='production' and restore_allowed=false and restore_target_id=:'target_id'::uuid) as final_marker_ok \gset
\if :final_marker_ok
commit;
\else
rollback;
\quit 4
\endif
\else
rollback;
\quit 3
\endif
\else
rollback;
\quit 3
\endif
\else
\quit 3
\endif
SQL
PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v target_database="$PROMOTE_CONFIRM_DATABASE" -c "select format('alter database %I allow_connections true', :'target_database')" -At | PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 >/dev/null
rm "$ready_dir/connections-disabled"
acl_after=$(PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v role="$PROMOTE_APP_ROLE" -AtF '|' -c "select has_database_privilege('public',current_database(),'connect'),has_database_privilege(:'role',current_database(),'connect')");[[ $acl_after == 'f|f' ]]||die "ACL reopened after isolation"
"$script_dir/reconcile-promotion-ready.sh" "$PROMOTE_STATE_DIR" "$PROMOTION_NONCE";rm -f "$reserve"
echo "promotion verified; app CONNECT remains revoked until finalize-cutover.sh"
