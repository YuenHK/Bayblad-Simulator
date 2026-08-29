#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
for script in "$script_dir/backup.sh" "$script_dir/restore.sh" "$0"; do
  bash -n "$script"
done

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$script_dir/backup.sh" "$script_dir/restore.sh" "$0"
elif [[ ${CI:-false} == true ]]; then
  echo "shellcheck is required in CI" >&2
  exit 1
else
  echo "SKIP: shellcheck is not installed" >&2
fi

required=(age age-keygen pg_dump pg_restore psql createdb dropdb)
missing=()
for command_name in "${required[@]}"; do command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name"); done
if [[ -z ${TEST_DATABASE_URL:-} || ${#missing[@]} -gt 0 ]]; then
  if [[ ${CI:-false} == true ]]; then
    echo "backup integration prerequisites missing: TEST_DATABASE_URL ${missing[*]:-}" >&2
    exit 1
  fi
  echo "SKIP: backup integration needs TEST_DATABASE_URL and: ${missing[*]:-all tools available}" >&2
  exit 0
fi
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  if [[ ${CI:-false} == true ]]; then echo "SHA-256 tool is required" >&2; exit 1; fi
  echo "SKIP: SHA-256 tool is missing" >&2; exit 0
fi

test_root=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-backup-test.XXXXXX")
chmod 700 "$test_root"
source_db="steam_top_backup_source_${RANDOM}_$$"
restore_db="steam_top_backup_restore_${RANDOM}_$$"
cleanup() {
  dropdb --if-exists --force --maintenance-db="$TEST_DATABASE_URL" "$source_db" >/dev/null 2>&1 || true
  dropdb --if-exists --force --maintenance-db="$TEST_DATABASE_URL" "$restore_db" >/dev/null 2>&1 || true
  rm -rf -- "$test_root"
}
trap cleanup EXIT INT TERM

createdb --maintenance-db="$TEST_DATABASE_URL" "$source_db"
createdb --maintenance-db="$TEST_DATABASE_URL" "$restore_db"
base_url=${TEST_DATABASE_URL%/*}
source_url="$base_url/$source_db"
restore_url="$base_url/$restore_db"
source_target_id=00000000-0000-4000-8000-000000000001
restore_target_id=00000000-0000-4000-8000-000000000002
psql "$source_url" -v ON_ERROR_STOP=1 -c "create table deletion_audit(id uuid primary key); create table deployment_environment(singleton boolean primary key,environment text,restore_allowed boolean,restore_target_id uuid); insert into deployment_environment values(true,'production',false,'$source_target_id'); create table backup_probe(id integer primary key, label text not null); insert into backup_probe values (1, 'encrypted-round-trip');" >/dev/null
psql "$restore_url" -v ON_ERROR_STOP=1 -c "create table deployment_environment(singleton boolean primary key,environment text,restore_allowed boolean,restore_target_id uuid); insert into deployment_environment values(true,'test',true,'$restore_target_id');" >/dev/null

age-keygen -o "$test_root/key.txt" 2>"$test_root/keygen.log"
recipient=$(awk '/^# public key: /{print $4}' "$test_root/key.txt")
ledger="$test_root/deletion-ledger.log"; : >"$ledger"; chmod 600 "$ledger"
DATABASE_URL="$source_url" BACKUP_DIR="$test_root/backups" AGE_RECIPIENT="$recipient" DELETION_LEDGER_FILE="$ledger" "$script_dir/backup.sh"
backup_file=$(find "$test_root/backups" -maxdepth 1 -type f -name 'steam-top-*.dump.age' -print -quit)
[[ -n $backup_file && -f $backup_file && ! -L $backup_file ]]
if stat -c '%a' "$backup_file" >/dev/null 2>&1; then mode=$(stat -c '%a' "$backup_file"); else mode=$(stat -f '%Lp' "$backup_file"); fi
[[ $mode == 600 ]]

restore_env=(RESTORE_DATABASE_URL="$restore_url" RESTORE_CONFIRM_DATABASE="$restore_db" AGE_IDENTITY_FILE="$test_root/key.txt" DELETION_LEDGER_FILE="$ledger" RESTORE_ALLOWED_TARGET_ID="$restore_target_id" NONPROD_RESTORE_CONFIRM=RESTORE_NONPRODUCTION_DATA)
env "${restore_env[@]}" "$script_dir/restore.sh" "$backup_file"
[[ $(psql "$restore_url" -Atqc "select label from backup_probe where id=1") == encrypted-round-trip ]]
psql "$restore_url" -v ON_ERROR_STOP=1 -c "update backup_probe set label='before-failed-restore' where id=1" >/dev/null
plain_dump="$test_root/plain.dump"; broken_dump="$test_root/broken.dump"; broken_backup="$test_root/backups/steam-top-20990101T000000Z-999999.dump.age"
age --decrypt --identity "$test_root/key.txt" --output "$plain_dump" "$backup_file"
plain_size=$(wc -c <"$plain_dump" | tr -d ' '); (( plain_size > 256 )); dd if="$plain_dump" of="$broken_dump" bs=1 count="$((plain_size-128))" 2>/dev/null
age --encrypt --recipient "$recipient" --output "$broken_backup" "$broken_dump"
if command -v sha256sum >/dev/null 2>&1; then broken_sha=$(sha256sum "$broken_backup" | awk '{print $1}'); else broken_sha=$(shasum -a 256 "$broken_backup" | awk '{print $1}'); fi
printf '%s  %s\n' "$broken_sha" "${broken_backup##*/}" >"$broken_backup.sha256"
awk -v hash="$broken_sha" '$0~/^sha256=/{print "sha256=" hash;next}{print}' "$backup_file.manifest" >"$broken_backup.manifest"
if env "${restore_env[@]}" "$script_dir/restore.sh" "$broken_backup" 2>/dev/null; then echo "corrupt restore unexpectedly succeeded" >&2; exit 1; fi
[[ $(psql "$restore_url" -Atqc "select label from backup_probe where id=1") == before-failed-restore ]]

if env APP_ENV=production "${restore_env[@]}" "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then
  echo "restore unexpectedly allowed production mode" >&2; exit 1
fi
if env RESTORE_DATABASE_URL="$source_url" RESTORE_CONFIRM_DATABASE="$source_db" AGE_IDENTITY_FILE="$test_root/key.txt" DELETION_LEDGER_FILE="$ledger" RESTORE_ALLOWED_TARGET_ID="$source_target_id" NONPROD_RESTORE_CONFIRM=RESTORE_NONPRODUCTION_DATA "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then
  echo "restore unexpectedly allowed the source database" >&2; exit 1
fi
printf 'P 10000000-0000-4000-8000-000000000001 %064d\nC 10000000-0000-4000-8000-000000000001 %064d\n' 0 0 >>"$ledger"
if env "${restore_env[@]}" "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then echo "restore unexpectedly accepted a backup older than the deletion ledger" >&2; exit 1; fi

echo "backup/restore integration passed"
