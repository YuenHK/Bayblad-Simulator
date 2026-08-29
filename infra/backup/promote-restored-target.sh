#!/usr/bin/env bash
set -euo pipefail
die(){ echo "promotion refused: $1" >&2;exit 1;}
[[ $# -eq 1 ]]||die "pass exactly one verified backup set"
source_set=$1;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)
# shellcheck source=host-trust-guard.sh
source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE PROMOTE_CONFIRM_DATABASE RESTORE_ALLOWED_TARGET_ID DELETION_LEDGER_FILE BACKUP_ALLOWED_SIGNERS_FILE BACKUP_SIGNER_ID PROMOTE_CONFIRM;do [[ -n ${!name:-} ]]||die "$name is required";done
[[ $PROMOTE_CONFIRM == PROMOTE_VERIFIED_RESTORE_TO_PRODUCTION && ${APP_ENV:-} != production && ${NODE_ENV:-} != production && -z ${DATABASE_URL:-} && -z ${RESTORE_DATABASE_URL:-} ]]||die "promotion confirmation/environment guard"
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq trust boundary"
for private in "$PGSERVICEFILE" "$PGPASSFILE" "$DELETION_LEDGER_FILE" "$BACKUP_ALLOWED_SIGNERS_FILE";do backup_private_file "$private"||die "private file trust boundary";done
ledger_cli="$script_dir/../../apps/server/dist/admin/deletion-ledger-cli.js";deployment_root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P)
backup_trusted_deployment "$deployment_root" "$script_dir" "${ledger_cli%/*}"||die "deployment trust boundary"
backup_trusted_ledger_cli "$deployment_root" "$script_dir" "$ledger_cli"||die "ledger CLI trust boundary"
ready_dir=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-promotion.XXXXXX");chmod 700 "$ready_dir";guard_pid=""
cleanup(){ if [[ -n $guard_pid ]];then kill "$guard_pid" >/dev/null 2>&1||true;wait "$guard_pid" >/dev/null 2>&1||true;fi;rm -rf "$ready_dir";};trap cleanup EXIT;trap 'cleanup;exit 130' INT TERM
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
marker=$(psql -X -v ON_ERROR_STOP=1 -AtF '|' -c 'select environment,restore_allowed,restore_target_id from restore_control.deployment_environment where singleton=true')
[[ $marker == "staging|t|$RESTORE_ALLOWED_TARGET_ID" || $marker == "test|t|$RESTORE_ALLOWED_TARGET_ID" ]]||die "target is not the verified non-production restore"
rows=$(psql -X -v ON_ERROR_STOP=1 -Atqc 'select count(*) from deletion_audit');[[ $rows == "$expected_rows" ]]||die "restored deletion audit count mismatch"
psql -X -v ON_ERROR_STOP=1 -v target_id="$RESTORE_ALLOWED_TARGET_ID" <<'SQL'
begin;
select pg_advisory_xact_lock(1937002751);
select exists (select 1 from restore_control.deployment_environment where singleton=true and environment in ('staging','test') and restore_allowed=true and restore_target_id=:'target_id'::uuid) as marker_ok \gset
\if :marker_ok
set local steam_top.configure_restore_target='RESTORE_NONPRODUCTION_DATA';
update restore_control.deployment_environment set environment='production',restore_allowed=false where singleton=true;
commit;
\else
rollback;
\quit 3
\endif
SQL
[[ $(psql -X -v ON_ERROR_STOP=1 -AtF '|' -c 'select environment,restore_allowed,restore_target_id from restore_control.deployment_environment where singleton=true') == "production|f|$RESTORE_ALLOWED_TARGET_ID" ]]||die "production marker verification failed"
echo "promotion verified; target $target is ready for guarded DATABASE_URL cutover"
