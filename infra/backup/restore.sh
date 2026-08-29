#!/usr/bin/env bash
set -euo pipefail
umask 077
die(){ echo "restore refused: $1" >&2;exit 1;}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)
[[ $# -eq 1 ]]||die "pass exactly one completed backup directory";backup_set=$1
for name in RESTORE_PGSERVICE PGSERVICEFILE PGPASSFILE RESTORE_CONFIRM_DATABASE AGE_IDENTITY_FILE DELETION_LEDGER_FILE DELETION_LEDGER_CLI RESTORE_ALLOWED_TARGET_ID NONPROD_RESTORE_CONFIRM BACKUP_ALLOWED_SIGNERS_FILE BACKUP_SIGNER_ID;do [[ -n ${!name:-} ]]||die "$name is required";done
[[ -z ${RESTORE_DATABASE_URL:-} && -z ${DATABASE_URL:-} ]]||die "database URLs are forbidden; use libpq service/passfile"
[[ $RESTORE_PGSERVICE =~ ^[A-Za-z0-9_.-]{1,64}$ ]]||die "RESTORE_PGSERVICE is invalid"
while IFS='=' read -r name _;do case "$name" in PGSERVICEFILE|PGPASSFILE) :;; PG*)die "libpq override $name is forbidden";;esac;done < <(env)
[[ $NONPROD_RESTORE_CONFIRM == RESTORE_NONPRODUCTION_DATA && ${APP_ENV:-} != production && ${NODE_ENV:-} != production ]]||die "production/confirmation guard"
for command_name in age pg_restore psql ssh-keygen;do command -v "$command_name" >/dev/null 2>&1||die "$command_name is required";done
base=${backup_set##*/};[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ && -d $backup_set && ! -L $backup_set && -f $backup_set/COMPLETE && $(<"$backup_set/COMPLETE") == complete ]]||die "backup set is incomplete or unsafe"
for file in dump.age checksum.sha256 manifest SIGNED-METADATA signature deletion-ledger.log;do [[ -f $backup_set/$file && ! -L $backup_set/$file ]]||die "backup set missing $file";done
private_file(){ local value=$1 mode uid;[[ -f $value && ! -L $value ]]||die "private file unsafe";if stat -c '%a %u' "$value" >/dev/null 2>&1;then read -r mode uid < <(stat -c '%a %u' "$value");else read -r mode uid < <(stat -f '%Lp %u' "$value");fi;[[ $uid == "$(id -u)" && $((8#$mode&077)) -eq 0 ]]||die "private file owner/mode unsafe";}
private_file "$AGE_IDENTITY_FILE";private_file "$DELETION_LEDGER_FILE";private_file "$PGSERVICEFILE";private_file "$PGPASSFILE";private_file "$BACKUP_ALLOWED_SIGNERS_FILE"
"$script_dir/verify-backup-set.sh" "$backup_set" "$BACKUP_ALLOWED_SIGNERS_FILE" "$BACKUP_SIGNER_ID" >/dev/null||die "backup set verification failed"
ssh-keygen -Y verify -q -f "$BACKUP_ALLOWED_SIGNERS_FILE" -I "$BACKUP_SIGNER_ID" -n steam-top-backup -s "$backup_set/signature" <"$backup_set/SIGNED-METADATA" >/dev/null||die "backup signature invalid"
expected_signed=$(mktemp "${TMPDIR:-/tmp}/steam-top-signed.XXXXXX");trap 'rm -f "$expected_signed"' EXIT INT TERM;{ cat "$backup_set/manifest";cat "$backup_set/checksum.sha256";} >"$expected_signed";cmp -s "$expected_signed" "$backup_set/SIGNED-METADATA"||die "signed metadata mismatch"
declare format= created_at= source_database= source_schema= verification_table= verification_rows= sha256= deletion_ledger_lines= deletion_ledger_sha256= signer_id=
while IFS='=' read -r key value;do case "$key" in format|created_at|source_database|source_schema|verification_table|verification_rows|sha256|deletion_ledger_lines|deletion_ledger_sha256|signer_id)printf -v "$key" '%s' "$value";;*)die "manifest field invalid";;esac;done <"$backup_set/manifest"
[[ $format == steam-top-age-pgdump-v3 && $created_at =~ ^[0-9]{8}T[0-9]{6}Z$ && $source_database =~ ^[A-Za-z0-9_.-]{1,63}$ && $source_schema =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ && $verification_table == deletion_audit && $verification_rows =~ ^[0-9]+$ && $sha256 =~ ^[a-f0-9]{64}$ && $deletion_ledger_lines =~ ^[0-9]+$ && $deletion_ledger_sha256 =~ ^[a-f0-9]{64}$ && $signer_id == "$BACKUP_SIGNER_ID" ]]||die "manifest invalid"
read -r checksum checksum_name extra <"$backup_set/checksum.sha256"||die "checksum invalid";[[ -z ${extra:-} && $checksum == "$sha256" && $checksum_name == dump.age ]]||die "checksum metadata mismatch"
if command -v sha256sum >/dev/null 2>&1;then actual=$(sha256sum "$backup_set/dump.age"|awk '{print $1}');ledger_actual=$(sha256sum "$DELETION_LEDGER_FILE"|awk '{print $1}');else actual=$(shasum -a 256 "$backup_set/dump.age"|awk '{print $1}');ledger_actual=$(shasum -a 256 "$DELETION_LEDGER_FILE"|awk '{print $1}');fi
[[ $actual == "$sha256" && $(wc -l <"$DELETION_LEDGER_FILE"|tr -d ' ') == "$deletion_ledger_lines" && $ledger_actual == "$deletion_ledger_sha256" ]]||die "checksum or deletion ledger mismatch/older backup"
export PGSERVICE=$RESTORE_PGSERVICE;target_database=$(psql -X -v ON_ERROR_STOP=1 -Atqc 'select current_database()');[[ $target_database == "$RESTORE_CONFIRM_DATABASE" && $target_database != "$source_database" ]]||die "target/source confirmation mismatch"
marker=$(psql -X -v ON_ERROR_STOP=1 -AtF '|' -c 'select environment,restore_allowed,restore_target_id from restore_control.deployment_environment where singleton=true');IFS='|' read -r marker_environment marker_allowed marker_target_id <<<"$marker";[[ $marker_environment != production && $marker_allowed == t && $marker_target_id == "$RESTORE_ALLOWED_TARGET_ID" ]]||die "database restore marker rejects target"
age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup_set/dump.age"|pg_restore --dbname="service=$RESTORE_PGSERVICE" --exit-on-error --single-transaction --clean --if-exists --no-owner --no-privileges
schema_exists=$(psql -X -v ON_ERROR_STOP=1 -Atqc "select count(*) from information_schema.schemata where schema_name='$source_schema'");restored_rows=$(psql -X -v ON_ERROR_STOP=1 -Atqc "select count(*) from \"$source_schema\".deletion_audit");marker_after=$(psql -X -v ON_ERROR_STOP=1 -AtF '|' -c 'select environment,restore_allowed,restore_target_id from restore_control.deployment_environment where singleton=true')
[[ $schema_exists == 1 && $restored_rows == "$verification_rows" && $marker_after == "$marker" ]]||die "post-restore verification failed"
echo "restore verified: $target_database"
