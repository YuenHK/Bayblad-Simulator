#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
for script in "$script_dir/backup.sh" "$script_dir/restore.sh" "$script_dir/verify-backup-set.sh" "$script_dir/verify-retention-set.sh" "$script_dir/scrub-backups.sh" "$0"; do
  bash -n "$script"
done
! grep -q 'mkfifo\|read ignored' "$script_dir/backup.sh"
grep -q 'loop perform pg_sleep' "$script_dir/backup.sh"
guard_output=$(env PGPASSWORD=exposed PGSERVICE=source PGSERVICEFILE=/tmp/service PGPASSFILE=/tmp/pass BACKUP_DIR=/tmp/backups AGE_RECIPIENT=age1test DELETION_LEDGER_FILE=/tmp/ledger DELETION_LEDGER_CLI=/tmp/cli BACKUP_SIGNING_KEY=/tmp/key BACKUP_SIGNER_ID=test BACKUP_ALLOWED_SIGNERS_FILE=/tmp/signers "$script_dir/backup.sh" 2>&1||true)
[[ $guard_output == *"libpq override PGPASSWORD is forbidden"* ]]
guard_output=$(env PGPASSWORD=exposed RESTORE_PGSERVICE=restore PGSERVICEFILE=/tmp/service PGPASSFILE=/tmp/pass RESTORE_CONFIRM_DATABASE=test AGE_IDENTITY_FILE=/tmp/key DELETION_LEDGER_FILE=/tmp/ledger DELETION_LEDGER_CLI=/tmp/cli RESTORE_ALLOWED_TARGET_ID=x NONPROD_RESTORE_CONFIRM=RESTORE_NONPRODUCTION_DATA BACKUP_ALLOWED_SIGNERS_FILE=/tmp/signers BACKUP_SIGNER_ID=test "$script_dir/restore.sh" /tmp/steam-top-20260101T000000Z-000001.backup 2>&1||true)
[[ $guard_output == *"libpq override PGPASSWORD is forbidden"* ]]

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$script_dir/backup.sh" "$script_dir/restore.sh" "$script_dir/verify-backup-set.sh" "$script_dir/verify-retention-set.sh" "$script_dir/scrub-backups.sh" "$0"
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

test_root=$(mktemp -d "${TMPDIR:-/tmp}/steam top "'`path`.XXXXXX')
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
service_file="$test_root/pg_service.conf";pass_file="$test_root/pgpass"
node - "$TEST_DATABASE_URL" "$source_db" "$restore_db" "$service_file" "$pass_file" <<'NODE'
const fs=require("fs"),[url,source,restore,file,pass]=process.argv.slice(2),u=new URL(url),host=u.hostname,port=u.port||"5432",user=decodeURIComponent(u.username),password=decodeURIComponent(u.password);const common=`host=${host}\nport=${port}\nuser=${user}\n`;fs.writeFileSync(file,`[source]\n${common}dbname=${source}\n[restore]\n${common}dbname=${restore}\n`,{mode:0o600});fs.writeFileSync(pass,`${host}:${port}:${source}:${user}:${password}\n${host}:${port}:${restore}:${user}:${password}\n`,{mode:0o600});
NODE
chmod 600 "$service_file" "$pass_file";export PGSERVICEFILE="$service_file" PGPASSFILE="$pass_file"
source_target_id=00000000-0000-4000-8000-000000000001
restore_target_id=00000000-0000-4000-8000-000000000002
migration="$script_dir/../../drizzle/0000_steam_top_pre_first_deploy.sql"
psql "$source_url" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
psql "$restore_url" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
psql "$source_url" -v ON_ERROR_STOP=1 -c "create table backup_probe(id integer primary key, label text not null); insert into backup_probe values (1, 'encrypted-round-trip');" >/dev/null
psql "$restore_url" -v ON_ERROR_STOP=1 -c "begin; set local steam_top.configure_restore_target='RESTORE_NONPRODUCTION_DATA'; update restore_control.deployment_environment set environment='test',restore_allowed=true,restore_target_id='$restore_target_id' where singleton=true; commit;" >/dev/null

age-keygen -o "$test_root/key.txt" 2>"$test_root/keygen.log"
recipient=$(awk '/^# public key: /{print $4}' "$test_root/key.txt")
ledger="$test_root/deletion-ledger.log"; : >"$ledger"; chmod 600 "$ledger"
ssh-keygen -q -t ed25519 -N '' -f "$test_root/signing-key";chmod 600 "$test_root/signing-key";signer=backup@test;printf '%s %s\n' "$signer" "$(<"$test_root/signing-key.pub")" >"$test_root/allowed-signers"
pnpm --filter @steam-top/server build >/dev/null;ledger_cli="$script_dir/../../apps/server/dist/admin/deletion-ledger-cli.js"
PGSERVICE=source BACKUP_DIR="$test_root/backups" AGE_RECIPIENT="$recipient" DELETION_LEDGER_FILE="$ledger" DELETION_LEDGER_CLI="$ledger_cli" BACKUP_SIGNING_KEY="$test_root/signing-key" BACKUP_SIGNER_ID="$signer" BACKUP_ALLOWED_SIGNERS_FILE="$test_root/allowed-signers" "$script_dir/backup.sh"
backup_file=$(find "$test_root/backups" -maxdepth 1 -type d -name 'steam-top-*.backup' -print -quit)
[[ -n $backup_file && -f $backup_file/COMPLETE && ! -L $backup_file ]]
if stat -c '%a' "$backup_file/dump.age" >/dev/null 2>&1; then mode=$(stat -c '%a' "$backup_file/dump.age"); else mode=$(stat -f '%Lp' "$backup_file/dump.age"); fi
[[ $mode == 600 ]]

for index in $(seq 0 29);do copy=$(printf '%s/backups/steam-top-202501%02dT000000Z-%06d.backup' "$test_root" "$((index+1))" "$index");cp -R "$backup_file" "$copy";done
invalid_retention="$test_root/backups/steam-top-20250201T000000Z-999996.backup";cp -R "$backup_file" "$invalid_retention";printf 'invalid\n' >"$invalid_retention/VERIFIED"
PGSERVICE=source BACKUP_DIR="$test_root/backups" AGE_RECIPIENT="$recipient" DELETION_LEDGER_FILE="$ledger" DELETION_LEDGER_CLI="$ledger_cli" BACKUP_SIGNING_KEY="$test_root/signing-key" BACKUP_SIGNER_ID="$signer" BACKUP_ALLOWED_SIGNERS_FILE="$test_root/allowed-signers" "$script_dir/backup.sh"
valid_sets=0;while IFS= read -r candidate;do if DELETION_LEDGER_CLI="$ledger_cli" "$script_dir/verify-retention-set.sh" "$candidate" "$test_root/allowed-signers" "$signer" >/dev/null 2>&1;then valid_sets=$((valid_sets+1));fi;done < <(find "$test_root/backups" -mindepth 1 -maxdepth 1 -type d -name 'steam-top-*.backup' -print);[[ $valid_sets -eq 30 && -d $invalid_retention ]]

restore_env=(RESTORE_PGSERVICE=restore RESTORE_CONFIRM_DATABASE="$restore_db" AGE_IDENTITY_FILE="$test_root/key.txt" DELETION_LEDGER_FILE="$ledger" DELETION_LEDGER_CLI="$ledger_cli" RESTORE_ALLOWED_TARGET_ID="$restore_target_id" NONPROD_RESTORE_CONFIRM=RESTORE_NONPRODUCTION_DATA BACKUP_ALLOWED_SIGNERS_FILE="$test_root/allowed-signers" BACKUP_SIGNER_ID="$signer")
env "${restore_env[@]}" "$script_dir/restore.sh" "$backup_file"
[[ $(psql "$restore_url" -Atqc "select label from backup_probe where id=1") == encrypted-round-trip ]]
psql "$restore_url" -v ON_ERROR_STOP=1 -c "update backup_probe set label='before-failed-restore' where id=1" >/dev/null
plain_dump="$test_root/plain.dump"; broken_dump="$test_root/broken.dump"; broken_backup="$test_root/backups/steam-top-20990101T000000Z-999999.backup";cp -R "$backup_file" "$broken_backup"
age --decrypt --identity "$test_root/key.txt" --output "$plain_dump" "$backup_file/dump.age"
plain_size=$(wc -c <"$plain_dump" | tr -d ' '); (( plain_size > 256 )); dd if="$plain_dump" of="$broken_dump" bs=1 count="$((plain_size-128))" 2>/dev/null
age --encrypt --recipient "$recipient" --output "$broken_backup/dump.age" "$broken_dump"
if command -v sha256sum >/dev/null 2>&1; then broken_sha=$(sha256sum "$broken_backup/dump.age" | awk '{print $1}'); else broken_sha=$(shasum -a 256 "$broken_backup/dump.age" | awk '{print $1}'); fi
printf '%s  dump.age\n' "$broken_sha" >"$broken_backup/checksum.sha256";awk -v hash="$broken_sha" '$0~/^sha256=/{print "sha256=" hash;next}{print}' "$backup_file/manifest" >"$broken_backup/manifest";{ cat "$broken_backup/manifest";cat "$broken_backup/checksum.sha256";} >"$broken_backup/SIGNED-METADATA";ssh-keygen -Y sign -q -f "$test_root/signing-key" -n steam-top-backup "$broken_backup/SIGNED-METADATA";mv "$broken_backup/SIGNED-METADATA.sig" "$broken_backup/signature"
if command -v sha256sum >/dev/null 2>&1;then broken_manifest_sha=$(sha256sum "$broken_backup/manifest"|awk '{print $1}');else broken_manifest_sha=$(shasum -a 256 "$broken_backup/manifest"|awk '{print $1}');fi;printf 'manifest_sha256=%s\n' "$broken_manifest_sha" >"$broken_backup/VERIFIED";ssh-keygen -Y sign -q -f "$test_root/signing-key" -n steam-top-backup-verified "$broken_backup/VERIFIED"
if env "${restore_env[@]}" "$script_dir/restore.sh" "$broken_backup" 2>/dev/null; then echo "corrupt restore unexpectedly succeeded" >&2; exit 1; fi
[[ $(psql "$restore_url" -Atqc "select label from backup_probe where id=1") == before-failed-restore ]]

if env APP_ENV=production "${restore_env[@]}" "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then
  echo "restore unexpectedly allowed production mode" >&2; exit 1
fi
if env RESTORE_PGSERVICE=source RESTORE_CONFIRM_DATABASE="$source_db" AGE_IDENTITY_FILE="$test_root/key.txt" DELETION_LEDGER_FILE="$ledger" RESTORE_ALLOWED_TARGET_ID="$source_target_id" NONPROD_RESTORE_CONFIRM=RESTORE_NONPRODUCTION_DATA BACKUP_ALLOWED_SIGNERS_FILE="$test_root/allowed-signers" BACKUP_SIGNER_ID="$signer" "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then
  echo "restore unexpectedly allowed the source database" >&2; exit 1
fi
incomplete="$test_root/backups/steam-top-20990101T000001Z-999998.backup";mkdir -m 700 "$incomplete";cp "$backup_file/dump.age" "$incomplete/dump.age";if env "${restore_env[@]}" "$script_dir/restore.sh" "$incomplete" 2>/dev/null;then echo "incomplete set accepted" >&2;exit 1;fi
tampered="$test_root/backups/steam-top-20990101T000002Z-999997.backup";cp -R "$backup_file" "$tampered";printf 'tamper\n' >>"$tampered/manifest";if env "${restore_env[@]}" "$script_dir/restore.sh" "$tampered" 2>/dev/null;then echo "tampered signature accepted" >&2;exit 1;fi
printf 'P 10000000-0000-4000-8000-000000000001 00000000-0000-4000-8000-000000000001 %064d\nC 10000000-0000-4000-8000-000000000001 %064d\n' 0 0 >>"$ledger"
if env "${restore_env[@]}" "$script_dir/restore.sh" "$backup_file" 2>/dev/null; then echo "restore unexpectedly accepted a backup older than the deletion ledger" >&2; exit 1; fi

echo "backup/restore integration passed"
