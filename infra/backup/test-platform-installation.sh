#!/usr/bin/env bash
set -euo pipefail
: "${TEST_DATABASE_URL:?}";root=$(CDPATH= cd -- "$(dirname "$0")/../.."&&pwd -P);db="install_claim_${RANDOM}_$$";service=$(mktemp);trap 'rm -f "$service";dropdb --if-exists --force --maintenance-db="$TEST_DATABASE_URL" "$db" >/dev/null 2>&1||true' EXIT;createdb --maintenance-db="$TEST_DATABASE_URL" "$db";url=${TEST_DATABASE_URL%/*}/$db;for migration in "$root"/drizzle/000{0,1,2}_*.sql;do psql "$url" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null;done;psql "$url" -v ON_ERROR_STOP=1 -c "create table app_schema_migrations(id text primary key,sha256 char(64) not null,applied_at timestamptz not null default now());insert into app_schema_migrations(id,sha256) values ('0000_steam_top_pre_first_deploy','48386c47be2562e241cb520f17cd2cd6d00ca221be6e84860ccebc4ac52c2be8'),('0001_cutover_state_machine','ca26cdef9195ae550a0fd4eb4db66fe02c2915e646a71e51182b4b4cf8a40571'),('0002_platform_installation','cb3dc38371bfaa56d14feb2f286be8dbeafc3dfe206dd0941d862973d7b60c62')" >/dev/null
psql "$url" -v ON_ERROR_STOP=1 -c "update public.app_schema_migrations set sha256='1135865894cd73de9c69649958fcaab0f663b64a4c97ae4d3b1c5d81e12f6e68' where id='0002_platform_installation'" >/dev/null
node - "$url" "$service" <<'NODE'
const fs=require("fs"),u=new URL(process.argv[2]);fs.writeFileSync(process.argv[3],`[claim]\nhost=${u.hostname}\nport=${u.port||5432}\ndbname=${u.pathname.slice(1)}\nuser=${decodeURIComponent(u.username)}\npassword=${decodeURIComponent(u.password)}\n`)
NODE
export PGSERVICE=claim PGSERVICEFILE=$service;a=$(printf a%.0s {1..64});b=$(printf b%.0s {1..64});c=$(printf c%.0s {1..64});claim(){ "$root/scripts/claim-first-installation.sh" "$@";}
psql "$url" -v ON_ERROR_STOP=1 -v app_password='test-app-password' -f "$root/scripts/provision-app-role.sql" >/dev/null
[[ $(psql "$url" -Atqc "select has_database_privilege('steam_top_app',current_database(),'connect') and has_schema_privilege('steam_top_app','public','usage') and not has_schema_privilege('steam_top_app','public','create') and not has_schema_privilege('steam_top_app','restore_control','usage') and not has_table_privilege('steam_top_app','public.app_schema_migrations','select,insert,update,delete')") == t ]]
psql "$url" -c 'grant pg_read_all_data to steam_top_app' >/dev/null
psql "$url" -c "alter role steam_top_app in database \"$db\" set search_path=pg_catalog;grant select(id) on public.app_schema_migrations to steam_top_app" >/dev/null
psql "$url" -v ON_ERROR_STOP=1 -v app_password='test-app-password' -f "$root/scripts/provision-app-role.sql" >/dev/null
[[ $(psql "$url" -Atqc "select count(*) from pg_auth_members m join pg_roles r on r.oid=m.member join pg_roles p on p.oid=m.roleid where r.rolname='steam_top_app' or p.rolname='steam_top_app'") == 0 ]]
[[ $(psql "$url" -Atqc "select count(*) from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='steam_top_app' and s.setdatabase=(select oid from pg_database where datname=current_database())") == 0 ]]
[[ $(psql "$url" -Atqc "select has_column_privilege('steam_top_app','public.app_schema_migrations','id','select')") == f ]]
psql "$url" -c 'create schema unexpected_app_owned authorization steam_top_app' >/dev/null
if psql "$url" -v ON_ERROR_STOP=1 -v app_password='test-app-password' -f "$root/scripts/provision-app-role.sql" >/dev/null 2>&1;then exit 1;fi
psql "$url" -c 'alter schema unexpected_app_owned owner to current_user;drop schema unexpected_app_owned' >/dev/null
[[ $(psql "$url" -Atqc "select count(*) from pg_tables where schemaname='restore_control' and tablename in ('promotion_outbox','promotion_audit','platform_installation')") == 3 ]]
psql "$url" -qAtc 'begin;select pg_advisory_xact_lock(1937002751);select pg_sleep(2);commit' >/dev/null & holder=$!
for _ in {1..40};do [[ $(psql "$url" -Atqc "select count(*) from pg_locks where locktype='advisory' and objid=1937002751 and granted") -gt 0 ]]&&break;sleep .05;done
started=$(date +%s);claim "$a" "$b" "$c";elapsed=$(( $(date +%s)-started ));wait "$holder";[[ $elapsed -ge 1 ]]
claim "$a" "$b" "$c";[[ $(psql "$url" -Atqc 'select count(*) from restore_control.platform_installation') == 1 ]];if claim "$a" "$b" "$(printf d%.0s {1..64})";then exit 1;fi
psql "$url" -c "delete from restore_control.platform_installation;insert into identities(status,display_name) values('active','x')" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "delete from identities;create table unexpected_durable_state(id bigint)" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "drop table unexpected_durable_state;create table restore_control.unexpected_authority(id bigint)" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "drop table restore_control.unexpected_authority;alter table restore_control.platform_installation add column unexpected_column text" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "alter table restore_control.platform_installation drop column unexpected_column;create index unexpected_authority_idx on restore_control.platform_installation(host_id)" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "drop index restore_control.unexpected_authority_idx;create type restore_control.unexpected_type as enum('x')" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "drop type restore_control.unexpected_type;alter function restore_control.deletion_audit_sha256() set search_path=public" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "alter function restore_control.deletion_audit_sha256() reset all;create or replace function restore_control.deletion_audit_sha256() returns text language sql stable as 'select ''wrong''::text'" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -v ON_ERROR_STOP=1 -f "$root/drizzle/0001_cutover_state_machine.sql" >/dev/null;psql "$url" -c "alter table restore_control.platform_installation alter column generation set default 2" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "alter table restore_control.platform_installation alter column generation set default 1;alter table restore_control.deployment_environment disable trigger deployment_environment_is_protected" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "alter table restore_control.deployment_environment enable trigger deployment_environment_is_protected;grant select on restore_control.platform_installation to public" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
