#!/usr/bin/env bash
set -euo pipefail
: "${TEST_DATABASE_URL:?}";root=$(CDPATH= cd -- "$(dirname "$0")/../.."&&pwd -P);db="install_claim_${RANDOM}_$$";service=$(mktemp);trap 'rm -f "$service";dropdb --if-exists --force --maintenance-db="$TEST_DATABASE_URL" "$db" >/dev/null 2>&1||true' EXIT;createdb --maintenance-db="$TEST_DATABASE_URL" "$db";url=${TEST_DATABASE_URL%/*}/$db;for migration in "$root"/drizzle/000{0,1,2}_*.sql;do psql "$url" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null;done
node - "$url" "$service" <<'NODE'
const fs=require("fs"),u=new URL(process.argv[2]);fs.writeFileSync(process.argv[3],`[claim]\nhost=${u.hostname}\nport=${u.port||5432}\ndbname=${u.pathname.slice(1)}\nuser=${decodeURIComponent(u.username)}\npassword=${decodeURIComponent(u.password)}\n`)
NODE
export PGSERVICE=claim PGSERVICEFILE=$service;a=$(printf a%.0s {1..64});b=$(printf b%.0s {1..64});c=$(printf c%.0s {1..64});claim(){ "$root/scripts/claim-first-installation.sh" "$@";}
claim "$a" "$b" "$c";claim "$a" "$b" "$c";[[ $(psql "$url" -Atqc 'select count(*) from restore_control.platform_installation') == 1 ]];if claim "$a" "$b" "$(printf d%.0s {1..64})";then exit 1;fi
psql "$url" -c "delete from restore_control.platform_installation;insert into identities(status,display_name) values('active','x')" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
psql "$url" -c "delete from identities;create table unexpected_durable_state(id bigint)" >/dev/null;if claim "$a" "$b" "$c";then exit 1;fi
