#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { echo "backup failed: $1" >&2; exit 1; }
for name in DATABASE_URL BACKUP_DIR AGE_RECIPIENT DELETION_LEDGER_FILE; do [[ -n ${!name:-} ]] || die "$name is required"; done
[[ $AGE_RECIPIENT =~ ^age1[0-9a-z]+$ ]] || die "AGE_RECIPIENT is invalid"
for command_name in pg_dump age psql; do command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"; done

mkdir -p -- "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
[[ -d $BACKUP_DIR && ! -L $BACKUP_DIR ]] || die "BACKUP_DIR must be a private real directory"
[[ -f $DELETION_LEDGER_FILE && ! -L $DELETION_LEDGER_FILE ]] || die "DELETION_LEDGER_FILE must be a regular non-symlink file"
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
ledger_tmp=$(mktemp "$backup_dir/.ledger.XXXXXX")
snapshot_meta=$(mktemp "$backup_dir/.snapshot.XXXXXX")
keeper_pid=""
cleanup() { if [[ -n $keeper_pid ]]; then kill "$keeper_pid" >/dev/null 2>&1 || true; fi; rm -f -- "$payload_tmp" "$checksum_tmp" "$manifest_tmp" "$ledger_tmp" "$snapshot_meta"; }
trap cleanup EXIT INT TERM
chmod 600 "$payload_tmp" "$checksum_tmp" "$manifest_tmp" "$ledger_tmp" "$snapshot_meta"
cp "$DELETION_LEDGER_FILE" "$ledger_tmp"
[[ $(awk '$1=="P"{p[$2]=1}$1=="C"||$1=="A"{delete p[$2]} NF!=3||$1!~/^[PCA]$/||$2!~/^[0-9a-f-]{36}$/||$3!~/^[a-f0-9]{64}$/{bad=1} END{for(x in p)pending=1; print bad||pending?"invalid":"ok"}' "$ledger_tmp") == ok ]] || die "deletion ledger is invalid or has an unresolved operation"
ledger_lines=$(wc -l <"$ledger_tmp" | tr -d ' ')
if command -v sha256sum >/dev/null 2>&1; then ledger_sha256=$(sha256sum "$ledger_tmp" | awk '{print $1}'); else ledger_sha256=$(shasum -a 256 "$ledger_tmp" | awk '{print $1}'); fi

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -At >"$snapshot_meta" <<'SQL' &
begin isolation level repeatable read read only;
select pg_export_snapshot();
select current_database();
select current_schema();
select count(*) from deletion_audit;
select pg_sleep(300);
rollback;
SQL
keeper_pid=$!
for _ in {1..100}; do [[ $(wc -l <"$snapshot_meta") -ge 4 ]] && break; sleep 0.1; done
[[ $(wc -l <"$snapshot_meta") -ge 4 ]] || die "could not export a consistent PostgreSQL snapshot"
snapshot_id=$(sed -n '1p' "$snapshot_meta"); source_database=$(sed -n '2p' "$snapshot_meta"); source_schema=$(sed -n '3p' "$snapshot_meta"); verification_rows=$(sed -n '4p' "$snapshot_meta")
[[ $source_database =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$ ]] || die "unsafe source database name"
[[ $source_schema =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "unsafe source schema"
verification_table=deletion_audit
[[ $snapshot_id =~ ^[0-9]+-[0-9A-F]+-[0-9]+$ && $verification_rows =~ ^[0-9]+$ ]] || die "invalid snapshot metadata"

pg_dump --format=custom --snapshot="$snapshot_id" --exclude-table=deployment_environment --no-owner --no-privileges "$DATABASE_URL" | age --encrypt --recipient "$AGE_RECIPIENT" --output "$payload_tmp"
kill "$keeper_pid" >/dev/null 2>&1 || true; wait "$keeper_pid" >/dev/null 2>&1 || true; keeper_pid=""
[[ -s $payload_tmp ]] || die "encrypted backup is empty"

if command -v sha256sum >/dev/null 2>&1; then checksum=$(sha256sum "$payload_tmp" | awk '{print $1}');
elif command -v shasum >/dev/null 2>&1; then checksum=$(shasum -a 256 "$payload_tmp" | awk '{print $1}');
else die "SHA-256 tool is required"; fi
[[ $checksum =~ ^[a-f0-9]{64}$ ]] || die "invalid checksum"
printf '%s  %s\n' "$checksum" "$base" >"$checksum_tmp"
printf 'format=steam-top-age-pgdump-v2\ncreated_at=%s\nsource_database=%s\nsource_schema=%s\nverification_table=%s\nverification_rows=%s\nsha256=%s\ndeletion_ledger_lines=%s\ndeletion_ledger_sha256=%s\n' "${timestamp}" "$source_database" "$source_schema" "$verification_table" "$verification_rows" "$checksum" "$ledger_lines" "$ledger_sha256" >"$manifest_tmp"

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
