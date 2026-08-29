#!/usr/bin/env bash
set -euo pipefail
die(){ echo "promotion refused: $1" >&2;exit 1;}
[[ $# -eq 1 ]]||die "pass exactly one verified backup set"
source_set=$1;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)
# shellcheck source=host-trust-guard.sh
source "$script_dir/host-trust-guard.sh"
[[ $(id -u) -eq 0 ]]||die "promotion must run as root"
for name in PROMOTE_PGSERVICE PROMOTE_MAINTENANCE_PGSERVICE PROMOTE_APP_ROLE PROMOTE_STATE_DIR PGSERVICEFILE PGPASSFILE PROMOTE_CONFIRM_DATABASE RESTORE_ALLOWED_TARGET_ID DELETION_LEDGER_FILE BACKUP_ALLOWED_SIGNERS_FILE BACKUP_SIGNER_ID PROMOTE_CONFIRM;do [[ -n ${!name:-} ]]||die "$name is required";done
[[ $PROMOTE_APP_ROLE =~ ^[a-z_][a-z0-9_]{0,62}$ ]]||die "application role invalid"
[[ $PROMOTE_CONFIRM_DATABASE =~ ^[a-z_][a-z0-9_]{0,62}$ ]]||die "database name invalid"
[[ $PROMOTE_STATE_DIR == /* && -d $PROMOTE_STATE_DIR && ! -L $PROMOTE_STATE_DIR ]]||die "state directory invalid"
read -r state_owner state_mode < <(stat -c '%u %a' "$PROMOTE_STATE_DIR" 2>/dev/null||stat -f '%u %Lp' "$PROMOTE_STATE_DIR");[[ $state_owner == 0 && $state_mode == 700 ]]||die "state directory must be root-owned 0700"
[[ $PROMOTE_CONFIRM == PROMOTE_VERIFIED_RESTORE_TO_PRODUCTION && ${APP_ENV:-} != production && ${NODE_ENV:-} != production && -z ${DATABASE_URL:-} && -z ${RESTORE_DATABASE_URL:-} ]]||die "promotion confirmation/environment guard"
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq trust boundary"
for private in "$PGSERVICEFILE" "$PGPASSFILE" "$DELETION_LEDGER_FILE" "$BACKUP_ALLOWED_SIGNERS_FILE";do backup_private_file "$private"||die "private file trust boundary";done
ledger_cli="$script_dir/../../apps/server/dist/admin/deletion-ledger-cli.js";deployment_root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P)
backup_trusted_root_deployment "$deployment_root" "$script_dir" "${ledger_cli%/*}"||die "deployment trust boundary"
backup_trusted_ledger_cli "$deployment_root" "$script_dir" "$ledger_cli"||die "ledger CLI trust boundary"
ready_dir=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-promotion.XXXXXX");chmod 700 "$ready_dir";guard_pid=""
restore_acl(){ IFS='|' read -r prior_allow prior_public prior_app <"$ready_dir/original-acl";for pair in "public:$prior_public" "$PROMOTE_APP_ROLE:$prior_app";do role=${pair%%:*};allowed=${pair#*:};verb=revoke;prep=from;[[ $allowed == t ]]&&{ verb=grant;prep=to;};PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v db="$PROMOTE_CONFIRM_DATABASE" -v role="$role" -v verb="$verb" -v prep="$prep" -Atc "select format('%s connect on database %I %s %I',:'verb',:'db',:'prep',:'role')"|PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 >/dev/null;done;PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v db="$PROMOTE_CONFIRM_DATABASE" -v allowed="$prior_allow" -Atc "select format('alter database %I allow_connections %s',:'db',case when :'allowed'='t' then 'true' else 'false' end)"|PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 >/dev/null;}
cleanup(){ local original=$1 recovery=0;if [[ -f $ready_dir/connections-disabled ]];then PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v target_database="$PROMOTE_CONFIRM_DATABASE" -c "select format('alter database %I allow_connections true', :'target_database')" -At | PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 >/dev/null||recovery=70;[[ $original -eq 0 || -f $ready_dir/promotion-committed ]]||restore_acl||recovery=70;fi;if [[ -f $ready_dir/promotion-committed && $original -ne 0 ]];then recovery=70;fi;if [[ -n $guard_pid ]];then kill "$guard_pid" >/dev/null 2>&1||true;wait "$guard_pid" >/dev/null 2>&1||true;fi;if [[ $recovery -ne 0 ]];then umask 077;incident="$PROMOTE_STATE_DIR/RECOVERY-REQUIRED.$(date -u +%Y%m%dT%H%M%SZ).$$";printf 'incident_path=%s\ndatabase=%s\nsystem_identifier=%s\ntime_utc=%s\nphase=%s\nmanual_action=restore ACL and ALLOW_CONNECTIONS from preserved snapshot\n' "$incident" "$PROMOTE_CONFIRM_DATABASE" "${target_system:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$([[ -f $ready_dir/promotion-committed ]]&&echo post-commit||echo pre-commit)" >"$incident";chmod 600 "$incident";echo "CRITICAL: durable recovery marker written; preserve $ready_dir" >&2;return "$recovery";fi;rm -rf "$ready_dir";return "$original";};trap 'rc=$?;trap - EXIT;cleanup "$rc";exit $?' EXIT;trap 'exit 130' INT TERM
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
PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v db="$PROMOTE_CONFIRM_DATABASE" -v role="$PROMOTE_APP_ROLE" -AtF '|' -c "select datallowconn,has_database_privilege('public',datname,'connect'),has_database_privilege(:'role',datname,'connect') from pg_database where datname=:'db'" >"$ready_dir/original-acl";chmod 400 "$ready_dir/original-acl"
touch "$ready_dir/connections-disabled"
psql -X -v ON_ERROR_STOP=1 -v target_id="$RESTORE_ALLOWED_TARGET_ID" -v expected_rows="$expected_rows" -v app_role="$PROMOTE_APP_ROLE" <<'SQL'
select format('revoke connect on database %I from public',current_database()) \gexec
select format('revoke connect on database %I from %I',current_database(),:'app_role') \gexec
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
set local steam_top.configure_restore_target='RESTORE_NONPRODUCTION_DATA';
update restore_control.deployment_environment set environment='production',restore_allowed=false where singleton=true;
commit;
select exists(select 1 from restore_control.deployment_environment where singleton=true and environment='production' and restore_allowed=false and restore_target_id=:'target_id'::uuid) as final_marker_ok \gset
\if :final_marker_ok
\else
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
touch "$ready_dir/promotion-committed"
PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v target_database="$PROMOTE_CONFIRM_DATABASE" -c "select format('alter database %I allow_connections true', :'target_database')" -At | PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 >/dev/null
rm "$ready_dir/connections-disabled"
ready_path="$PROMOTE_STATE_DIR/promotion-ready";[[ ! -e $ready_path && ! -e $ready_path.sha256 ]]||die "unconsumed promotion state exists";node "$deployment_root/scripts/create-promotion-ready.mjs" "$ready_path" "$target_system" "$target" "$PROMOTE_APP_ROLE" "$RESTORE_ALLOWED_TARGET_ID" "$expected_rows";"$deployment_root/scripts/portable-sha256.sh" digest "$ready_path" >"$ready_path.sha256";chmod 400 "$ready_path.sha256"
echo "promotion verified; app CONNECT remains revoked until finalize-cutover.sh"
