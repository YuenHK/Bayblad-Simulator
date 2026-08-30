#!/usr/bin/env bash
set -euo pipefail
: "${TEST_DATABASE_URL:?}";base=${TEST_DATABASE_URL%/*};db=steam_top_cutover_upgrade_$$;bad_db=steam_top_cutover_bad_$$;createdb --maintenance-db="$TEST_DATABASE_URL" "$db";createdb --maintenance-db="$TEST_DATABASE_URL" "$bad_db";trap 'dropdb --if-exists --force --maintenance-db="$TEST_DATABASE_URL" "$db" "$bad_db" >/dev/null 2>&1||true' EXIT;url="$base/$db";apply_migration(){ psql "$url" -v ON_ERROR_STOP=1 -f drizzle/0001_cutover_state_machine.sql >/dev/null;}
psql "$url" -v ON_ERROR_STOP=1 <<'SQL'
create table deletion_audit(id uuid primary key,admin_user_id uuid,scope text,filter_hash text,preview_count integer,deleted_identity_count integer,deleted_design_count integer,deleted_match_count integer,transaction_id bigint,completed_at timestamptz);create schema restore_control;create table restore_control.finalize_outbox(nonce text primary key,restore_target_id uuid not null,app_role text not null check(app_role~'^[a-z_]+$'),ledger_rows bigint not null,state text not null,constraint finalize_outbox_state_check check(state='committed'),created_at timestamptz not null default clock_timestamp(),constraint unrelated_state_check check(state <> 'uncommitted'));insert into restore_control.finalize_outbox values(repeat('a',64),'00000000-0000-4000-8000-000000000001','steam_top_app',2,'committed',clock_timestamp());
SQL
apply_migration
[[ $(psql "$url" -Atqc "select state from restore_control.finalize_outbox where nonce=repeat('a',64)") == legacy-committed ]]
[[ $(psql "$url" -Atqc "select count(*) from pg_constraint where conrelid='restore_control.finalize_outbox'::regclass and pg_get_constraintdef(oid) like '%app_role%'") == 1 ]]
[[ $(psql "$url" -Atqc "select count(*) from pg_constraint where conrelid='restore_control.finalize_outbox'::regclass and conname='unrelated_state_check'") == 1 ]]
apply_migration
psql "$url" -v ON_ERROR_STOP=1 -c "insert into deletion_audit values('00000000-0000-4000-8000-000000000001',null,'all',repeat('a',64),1,1,0,0,7,'2026-08-30 12:34:56.123456+00')" >/dev/null
utc=$(psql "$url" -Atqc "set time zone 'UTC';select restore_control.deletion_audit_sha256()")
hk=$(psql "$url" -Atqc "set time zone 'Asia/Hong_Kong';select restore_control.deletion_audit_sha256()")
ny=$(psql "$url" -Atqc "set time zone 'America/New_York';select restore_control.deletion_audit_sha256()")
[[ $utc =~ ^[a-f0-9]{64}$ && $utc == "$hk" && $utc == "$ny" ]]
psql "$base/$bad_db" -v ON_ERROR_STOP=1 -c "create schema restore_control;create table restore_control.finalize_outbox(nonce text primary key,restore_target_id uuid not null,app_role text not null,ledger_rows bigint not null,state text not null constraint finalize_outbox_state_check check(state in ('committed','failed')),created_at timestamptz not null default clock_timestamp())" >/dev/null
if psql "$base/$bad_db" -v ON_ERROR_STOP=1 -f drizzle/0001_cutover_state_machine.sql >/dev/null 2>&1;then echo 'unexpected legacy constraint was accepted' >&2;exit 1;fi
for item in "b:preflight-recorded" "c:connect-granted-pending-smoke" "d:smoke-observed" "e:verified" "f:aborted";do key=${item%%:*};state=${item#*:};psql "$url" -v state="$state" -v nonce="$(printf "$key%.0s" {1..64})" -c "insert into restore_control.finalize_outbox(nonce,restore_target_id,app_role,ledger_rows,state) values(:'nonce','00000000-0000-4000-8000-000000000001','steam_top_app',2,:'state')" >/dev/null;done
[[ $(psql "$url" -Atqc 'select count(*) from restore_control.finalize_outbox') == 6 ]]
