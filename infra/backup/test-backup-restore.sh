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
psql "$source_url" -v ON_ERROR_STOP=1 -c "create table backup_probe(id integer primary key, label text not null); insert into backup_probe values (1, 'encrypted-round-trip');" >/dev/null

age-keygen -o "$test_root/key.txt" 2>"$test_root/keygen.log"
recipient=$(awk '/^# public key: /{print $4}' "$test_root/key.txt")
DATABASE_URL="$source_url" BACKUP_DIR="$test_root/backups" AGE_RECIPIENT="$recipient" "$script_dir/backup.sh"
backup_file=$(find "$test_root/backups" -maxdepth 1 -type f -name 'steam-top-*.dump.age' -print -quit)
[[ -n $backup_file && -f $backup_file && ! -L $backup_file ]]
if stat -c '%a' "$backup_file" >/dev/null 2>&1; then mode=$(stat -c '%a' "$backup_file"); else mode=$(stat -f '%Lp' "$backup_file"); fi
[[ $mode == 600 ]]

RESTORE_DATABASE_URL="$restore_url" RESTORE_CONFIRM_DATABASE="$restore_db" AGE_IDENTITY_FILE="$test_root/key.txt" "$script_dir/restore.sh" "$backup_file"
[[ $(psql "$restore_url" -Atqc "select label from backup_probe where id=1") == encrypted-round-trip ]]

if APP_ENV=production RESTORE_DATABASE_URL="$restore_url" RESTORE_CONFIRM_DATABASE="$restore_db" AGE_IDENTITY_FILE="$test_root/key.txt" "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then
  echo "restore unexpectedly allowed production mode" >&2; exit 1
fi
if RESTORE_DATABASE_URL="$source_url" RESTORE_CONFIRM_DATABASE="$source_db" AGE_IDENTITY_FILE="$test_root/key.txt" "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then
  echo "restore unexpectedly allowed the source database" >&2; exit 1
fi

echo "backup/restore integration passed"
