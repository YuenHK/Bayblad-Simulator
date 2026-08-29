#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { echo "backup failed: $1" >&2; exit 1; }
for name in DATABASE_URL BACKUP_DIR AGE_RECIPIENT; do [[ -n ${!name:-} ]] || die "$name is required"; done
[[ $AGE_RECIPIENT =~ ^age1[0-9a-z]+$ ]] || die "AGE_RECIPIENT is invalid"
for command_name in pg_dump age psql; do command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"; done

mkdir -p -- "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
[[ -d $BACKUP_DIR && ! -L $BACKUP_DIR ]] || die "BACKUP_DIR must be a private real directory"
backup_dir=$(CDPATH= cd -- "$BACKUP_DIR" && pwd -P)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
serial=$(printf '%06d' "$(( ($$ + RANDOM) % 1000000 ))")
base="steam-top-${timestamp}-${serial}.dump.age"
[[ $base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.dump\.age$ ]] || die "unsafe backup name"
final="$backup_dir/$base"
[[ ! -e $final ]] || die "backup collision"
payload_tmp=$(mktemp "$backup_dir/.payload.XXXXXX")
checksum_tmp=$(mktemp "$backup_dir/.checksum.XXXXXX")
manifest_tmp=$(mktemp "$backup_dir/.manifest.XXXXXX")
cleanup() { rm -f -- "$payload_tmp" "$checksum_tmp" "$manifest_tmp"; }
trap cleanup EXIT INT TERM
chmod 600 "$payload_tmp" "$checksum_tmp" "$manifest_tmp"

source_database=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select current_database()")
source_schema=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select current_schema()")
[[ $source_database =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$ ]] || die "unsafe source database name"
[[ $source_schema =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "unsafe source schema"
verification_table=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select table_name from information_schema.tables where table_schema=current_schema() and table_type='BASE TABLE' order by table_name limit 1")
verification_rows=0
if [[ -n $verification_table ]]; then
  [[ $verification_table =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "unsafe verification table"
  verification_rows=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "select count(*) from \"$verification_table\"")
  [[ $verification_rows =~ ^[0-9]+$ ]] || die "invalid verification count"
fi

pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" | age --encrypt --recipient "$AGE_RECIPIENT" --output "$payload_tmp"
[[ -s $payload_tmp ]] || die "encrypted backup is empty"

if command -v sha256sum >/dev/null 2>&1; then checksum=$(sha256sum "$payload_tmp" | awk '{print $1}');
elif command -v shasum >/dev/null 2>&1; then checksum=$(shasum -a 256 "$payload_tmp" | awk '{print $1}');
else die "SHA-256 tool is required"; fi
[[ $checksum =~ ^[a-f0-9]{64}$ ]] || die "invalid checksum"
printf '%s  %s\n' "$checksum" "$base" >"$checksum_tmp"
printf 'format=steam-top-age-pgdump-v1\ncreated_at=%s\nsource_database=%s\nsource_schema=%s\nverification_table=%s\nverification_rows=%s\nsha256=%s\n' "${timestamp}" "$source_database" "$source_schema" "$verification_table" "$verification_rows" "$checksum" >"$manifest_tmp"

mv -- "$payload_tmp" "$final"
mv -- "$checksum_tmp" "$final.sha256"
mv -- "$manifest_tmp" "$final.manifest"
chmod 600 "$final" "$final.sha256" "$final.manifest"
trap - EXIT INT TERM

# Retention only touches complete, regular, non-symlink files with our exact basename.
backups=()
while IFS= read -r candidate; do
  [[ -f $candidate.sha256 && ! -L $candidate.sha256 && -f $candidate.manifest && ! -L $candidate.manifest ]] && backups+=("$candidate")
done < <(find "$backup_dir" -maxdepth 1 -type f -name 'steam-top-*.dump.age' -print | LC_ALL=C sort)
excess=$(( ${#backups[@]} - 30 ))
if (( excess > 0 )); then
  for (( index=0; index<excess; index++ )); do
    old=${backups[$index]}; old_base=${old##*/}
    [[ $old_base =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.dump\.age$ && -f $old && ! -L $old ]] || continue
    for target in "$old" "$old.sha256" "$old.manifest"; do [[ -f $target && ! -L $target ]] && rm -f -- "$target"; done
  done
fi
echo "backup created: $base"
