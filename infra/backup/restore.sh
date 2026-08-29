#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { echo "restore refused: $1" >&2; exit 1; }
[[ $# -eq 1 ]] || die "pass exactly one encrypted backup file"
backup=$1
for name in RESTORE_DATABASE_URL RESTORE_CONFIRM_DATABASE AGE_IDENTITY_FILE; do [[ -n ${!name:-} ]] || die "$name is required"; done
[[ ${APP_ENV:-} != production && ${NODE_ENV:-} != production ]] || die "production runtime is forbidden"
for command_name in age pg_restore psql; do command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"; done
[[ -f $backup && ! -L $backup ]] || die "backup must be an explicit regular non-symlink file"
base=${backup##*/}
[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.dump\.age$ ]] || die "backup filename is not recognized"
checksum_file="$backup.sha256"; manifest_file="$backup.manifest"
[[ -f $checksum_file && ! -L $checksum_file && -f $manifest_file && ! -L $manifest_file ]] || die "checksum and manifest are required"
[[ -f $AGE_IDENTITY_FILE && ! -L $AGE_IDENTITY_FILE ]] || die "AGE_IDENTITY_FILE must be a regular non-symlink file"

declare format= created_at= source_database= source_schema= verification_table= verification_rows= sha256=
while IFS='=' read -r key value; do
  case "$key" in
    format|created_at|source_database|source_schema|verification_table|verification_rows|sha256) printf -v "$key" '%s' "$value" ;;
    *) die "manifest contains an unknown field" ;;
  esac
done <"$manifest_file"
[[ $format == steam-top-age-pgdump-v1 && $created_at =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "manifest format is invalid"
[[ $source_database =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$ && $source_schema =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "manifest source is invalid"
[[ -z $verification_table || $verification_table =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "manifest table is invalid"
[[ $verification_rows =~ ^[0-9]+$ && $sha256 =~ ^[a-f0-9]{64}$ ]] || die "manifest verification is invalid"
read -r checksum checksum_name extra <"$checksum_file" || die "checksum file is invalid"
[[ -z ${extra:-} && $checksum == "$sha256" && $checksum_name == "$base" ]] || die "checksum metadata mismatch"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$backup" | awk '{print $1}');
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$backup" | awk '{print $1}');
else die "SHA-256 tool is required"; fi
[[ $actual == "$sha256" ]] || die "encrypted backup checksum mismatch"

target_database=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select current_database()")
[[ $target_database == "$RESTORE_CONFIRM_DATABASE" ]] || die "RESTORE_CONFIRM_DATABASE does not match the connected target"
[[ $target_database != "$source_database" ]] || die "source and target database must differ"
lower_target=$(printf '%s' "$target_database" | tr '[:upper:]' '[:lower:]')
[[ $lower_target != *prod* && $lower_target != steam_top ]] || die "target database resembles production"
case "$lower_target" in *test*|*restore*|*staging*|*drill*) ;; *) die "target database name is not explicitly non-production" ;; esac

age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup" | pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL"
schema_exists=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select count(*) from information_schema.schemata where schema_name='$source_schema'")
[[ $schema_exists == 1 ]] || die "restored schema verification failed"
if [[ -n $verification_table ]]; then
  restored_rows=$(psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select count(*) from \"$source_schema\".\"$verification_table\"")
  [[ $restored_rows == "$verification_rows" ]] || die "restored row verification failed"
fi
echo "restore verified: $target_database"
