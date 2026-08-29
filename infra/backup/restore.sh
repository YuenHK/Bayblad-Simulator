#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { echo "restore refused: $1" >&2; exit 1; }
[[ $# -eq 1 ]] || die "pass exactly one encrypted backup file"
backup=$1
for name in RESTORE_DATABASE_URL RESTORE_CONFIRM_DATABASE AGE_IDENTITY_FILE DELETION_LEDGER_FILE RESTORE_ALLOWED_TARGET_ID NONPROD_RESTORE_CONFIRM; do [[ -n ${!name:-} ]] || die "$name is required"; done
[[ $NONPROD_RESTORE_CONFIRM == RESTORE_NONPRODUCTION_DATA ]] || die "NONPROD_RESTORE_CONFIRM phrase is incorrect"
[[ ${APP_ENV:-} != production && ${NODE_ENV:-} != production ]] || die "production runtime is forbidden"
for command_name in age pg_restore psql; do command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"; done
[[ -f $backup && ! -L $backup ]] || die "backup must be an explicit regular non-symlink file"
base=${backup##*/}
[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.dump\.age$ ]] || die "backup filename is not recognized"
checksum_file="$backup.sha256"; manifest_file="$backup.manifest"
[[ -f $checksum_file && ! -L $checksum_file && -f $manifest_file && ! -L $manifest_file ]] || die "checksum and manifest are required"
[[ -f $AGE_IDENTITY_FILE && ! -L $AGE_IDENTITY_FILE ]] || die "AGE_IDENTITY_FILE must be a regular non-symlink file"
[[ -f $DELETION_LEDGER_FILE && ! -L $DELETION_LEDGER_FILE ]] || die "DELETION_LEDGER_FILE must be a regular non-symlink file"

declare format= created_at= source_database= source_schema= verification_table= verification_rows= sha256= deletion_ledger_lines= deletion_ledger_sha256=
while IFS='=' read -r key value; do
  case "$key" in
    format|created_at|source_database|source_schema|verification_table|verification_rows|sha256|deletion_ledger_lines|deletion_ledger_sha256) printf -v "$key" '%s' "$value" ;;
    *) die "manifest contains an unknown field" ;;
  esac
done <"$manifest_file"
[[ $format == steam-top-age-pgdump-v2 && $created_at =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "manifest format is invalid"
[[ $source_database =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$ && $source_schema =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "manifest source is invalid"
[[ -z $verification_table || $verification_table =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "manifest table is invalid"
[[ $verification_rows =~ ^[0-9]+$ && $sha256 =~ ^[a-f0-9]{64}$ ]] || die "manifest verification is invalid"
[[ $deletion_ledger_lines =~ ^[0-9]+$ && $deletion_ledger_sha256 =~ ^[a-f0-9]{64}$ ]] || die "manifest deletion ledger is invalid"
read -r checksum checksum_name extra <"$checksum_file" || die "checksum file is invalid"
[[ -z ${extra:-} && $checksum == "$sha256" && $checksum_name == "$base" ]] || die "checksum metadata mismatch"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$backup" | awk '{print $1}');
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$backup" | awk '{print $1}');
else die "SHA-256 tool is required"; fi
[[ $actual == "$sha256" ]] || die "encrypted backup checksum mismatch"
current_ledger_lines=$(wc -l <"$DELETION_LEDGER_FILE" | tr -d ' ')
if command -v sha256sum >/dev/null 2>&1; then current_ledger_sha256=$(sha256sum "$DELETION_LEDGER_FILE" | awk '{print $1}'); else current_ledger_sha256=$(shasum -a 256 "$DELETION_LEDGER_FILE" | awk '{print $1}'); fi
[[ $current_ledger_lines == "$deletion_ledger_lines" && $current_ledger_sha256 == "$deletion_ledger_sha256" ]] || die "backup predates the current deletion ledger"

target_database=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select current_database()")
[[ $target_database == "$RESTORE_CONFIRM_DATABASE" ]] || die "RESTORE_CONFIRM_DATABASE does not match the connected target"
[[ $target_database != "$source_database" ]] || die "source and target database must differ"
lower_target=$(printf '%s' "$target_database" | tr '[:upper:]' '[:lower:]')
[[ $lower_target != *prod* && $lower_target != steam_top ]] || die "target database resembles production"
case "$lower_target" in *test*|*restore*|*staging*|*drill*) ;; *) die "target database name is not explicitly non-production" ;; esac
marker=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -AtF '|' -c "select environment,restore_allowed,restore_target_id from deployment_environment where singleton=true")
IFS='|' read -r marker_environment marker_allowed marker_target_id <<<"$marker"
[[ $marker_environment != production && $marker_allowed == t && $marker_target_id == "$RESTORE_ALLOWED_TARGET_ID" ]] || die "database restore marker does not authorize this exact target"

age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup" | pg_restore --exit-on-error --single-transaction --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL"
schema_exists=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select count(*) from information_schema.schemata where schema_name='$source_schema'")
[[ $schema_exists == 1 ]] || die "restored schema verification failed"
if [[ -n $verification_table ]]; then
  restored_rows=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select count(*) from \"$source_schema\".\"$verification_table\"")
  [[ $restored_rows == "$verification_rows" ]] || die "restored row verification failed"
fi
marker_after=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -AtF '|' -c "select environment,restore_allowed,restore_target_id from deployment_environment where singleton=true")
[[ $marker_after == "$marker" ]] || die "restore target marker changed unexpectedly"
echo "restore verified: $target_database"
