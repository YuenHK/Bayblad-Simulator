#!/usr/bin/env bash
set -euo pipefail
umask 077
die(){ echo "backup failed: $1" >&2;exit 1;}
for name in PGSERVICE BACKUP_DIR AGE_RECIPIENT DELETION_LEDGER_FILE BACKUP_SIGNING_KEY BACKUP_SIGNER_ID;do [[ -n ${!name:-} ]]||die "$name is required";done
[[ -z ${DATABASE_URL:-} ]]||die "DATABASE_URL is forbidden; use libpq PGSERVICE/PGPASSFILE"
[[ $AGE_RECIPIENT =~ ^age1[0-9a-z]+$ && $BACKUP_SIGNER_ID =~ ^[A-Za-z0-9._@-]{1,128}$ ]]||die "recipient or signer is invalid"
for command_name in pg_dump age psql ssh-keygen node;do command -v "$command_name" >/dev/null 2>&1||die "$command_name is required";done
secure_file(){ local value=$1 mode uid;[[ -f $value && ! -L $value ]]||die "private key/ledger must be a regular file";if stat -c '%a %u' "$value" >/dev/null 2>&1;then read -r mode uid < <(stat -c '%a %u' "$value");else read -r mode uid < <(stat -f '%Lp %u' "$value");fi;[[ $uid == "$(id -u)" && $((8#$mode & 077)) -eq 0 ]]||die "private file owner/mode is unsafe";}
secure_file "$BACKUP_SIGNING_KEY";secure_file "$DELETION_LEDGER_FILE"
[[ -z ${PGPASSFILE:-} ]]||secure_file "$PGPASSFILE"
mkdir -p "$BACKUP_DIR";chmod 700 "$BACKUP_DIR";[[ -d $BACKUP_DIR && ! -L $BACKUP_DIR ]]||die "BACKUP_DIR is unsafe";backup_dir=$(CDPATH= cd -- "$BACKUP_DIR"&&pwd -P)
timestamp=$(date -u +%Y%m%dT%H%M%SZ);serial=$(printf '%06d' "$((($$+RANDOM)%1000000))");set_name="steam-top-${timestamp}-${serial}.backup";[[ $set_name =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ ]]||die "unsafe set name"
staging=$(mktemp -d "$backup_dir/.staging-XXXXXX");chmod 700 "$staging";final="$backup_dir/$set_name";[[ ! -e $final ]]||die "backup collision"
snapshot_meta="$staging/.snapshot";release_fifo="$staging/.release";mkfifo -m 600 "$release_fifo";keeper_pid=""
cleanup(){ if [[ -n $keeper_pid ]];then kill "$keeper_pid" >/dev/null 2>&1||true;wait "$keeper_pid" >/dev/null 2>&1||true;fi;[[ -n ${staging:-} && -d $staging && ! -L $staging ]]&&rm -rf "$staging";};trap cleanup EXIT INT TERM
cp "$DELETION_LEDGER_FILE" "$staging/deletion-ledger.log";chmod 600 "$staging/deletion-ledger.log"
[[ $(awk '$1=="P"{p[$2]=1}$1=="C"||$1=="A"{delete p[$2]}NF!=3||$1!~/^[PCA]$/||$2!~/^[0-9a-f-]{36}$/||$3!~/^[a-f0-9]{64}$/{bad=1}END{for(x in p)pending=1;print bad||pending?"invalid":"ok"}' "$staging/deletion-ledger.log") == ok ]]||die "deletion ledger invalid or unresolved"
ledger_lines=$(wc -l <"$staging/deletion-ledger.log"|tr -d ' ');if command -v sha256sum >/dev/null 2>&1;then ledger_sha256=$(sha256sum "$staging/deletion-ledger.log"|awk '{print $1}');else ledger_sha256=$(shasum -a 256 "$staging/deletion-ledger.log"|awk '{print $1}');fi
psql -X -q -v ON_ERROR_STOP=1 -At >"$snapshot_meta" <<SQL &
begin isolation level repeatable read read only;
select pg_export_snapshot();
select current_database();
select current_schema();
select count(*) from deletion_audit;
\! read ignored < "$release_fifo"
rollback;
SQL
keeper_pid=$!;for _ in {1..100};do [[ $(wc -l <"$snapshot_meta") -ge 4 ]]&&break;sleep 0.1;done;[[ $(wc -l <"$snapshot_meta") -ge 4 ]]||die "snapshot keeper failed"
snapshot_id=$(sed -n '1p' "$snapshot_meta");source_database=$(sed -n '2p' "$snapshot_meta");source_schema=$(sed -n '3p' "$snapshot_meta");verification_rows=$(sed -n '4p' "$snapshot_meta");[[ $snapshot_id =~ ^[0-9]+-[0-9A-F]+-[0-9]+$ && $source_database =~ ^[A-Za-z0-9_.-]{1,63}$ && $source_schema =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ && $verification_rows =~ ^[0-9]+$ ]]||die "snapshot metadata invalid"
pg_dump --format=custom --snapshot="$snapshot_id" --exclude-schema='restore_control' --no-owner --no-privileges|age --encrypt --recipient "$AGE_RECIPIENT" --output "$staging/dump.age"
printf 'release\n' >"$release_fifo";wait "$keeper_pid";keeper_pid="";rm "$release_fifo" "$snapshot_meta"
[[ -s $staging/dump.age ]]||die "encrypted dump empty";if command -v sha256sum >/dev/null 2>&1;then checksum=$(sha256sum "$staging/dump.age"|awk '{print $1}');else checksum=$(shasum -a 256 "$staging/dump.age"|awk '{print $1}');fi
printf '%s  dump.age\n' "$checksum" >"$staging/checksum.sha256"
printf 'format=steam-top-age-pgdump-v3\ncreated_at=%s\nsource_database=%s\nsource_schema=%s\nverification_table=deletion_audit\nverification_rows=%s\nsha256=%s\ndeletion_ledger_lines=%s\ndeletion_ledger_sha256=%s\nsigner_id=%s\n' "$timestamp" "$source_database" "$source_schema" "$verification_rows" "$checksum" "$ledger_lines" "$ledger_sha256" "$BACKUP_SIGNER_ID" >"$staging/manifest"
{ cat "$staging/manifest";cat "$staging/checksum.sha256";} >"$staging/SIGNED-METADATA";ssh-keygen -Y sign -q -f "$BACKUP_SIGNING_KEY" -n steam-top-backup "$staging/SIGNED-METADATA";mv "$staging/SIGNED-METADATA.sig" "$staging/signature"
for file in dump.age checksum.sha256 manifest SIGNED-METADATA signature deletion-ledger.log;do chmod 600 "$staging/$file";node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");fs.fsyncSync(fd);fs.closeSync(fd)' "$staging/$file";done
printf 'complete\n' >"$staging/COMPLETE";chmod 600 "$staging/COMPLETE";node -e 'const fs=require("fs");for(const p of process.argv.slice(1)){const fd=fs.openSync(p,"r");fs.fsyncSync(fd);fs.closeSync(fd)}' "$staging/COMPLETE" "$staging"
mv "$staging" "$final";staging="";node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");fs.fsyncSync(fd);fs.closeSync(fd)' "$backup_dir";trap - EXIT INT TERM
sets=();while IFS= read -r candidate;do [[ -d $candidate && ! -L $candidate && -f $candidate/COMPLETE ]]&&sets+=("$candidate");done < <(find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name 'steam-top-*.backup' -print|LC_ALL=C sort);excess=$((${#sets[@]}-30));if((excess>0));then for((i=0;i<excess;i++));do old=${sets[$i]};[[ ${old##*/} =~ ^steam-top-[0-9]{8}T[0-9]{6}Z-[0-9]{6}\.backup$ && -d $old && ! -L $old && -f $old/COMPLETE ]]&&rm -rf "$old";done;fi
echo "backup created: $set_name"
