#!/usr/bin/env bash
set -euo pipefail
: "${TEST_DATABASE_URL:?}"
maintenance=${TEST_DATABASE_URL%/*}/postgres;database=steam_top_promotion_ci
psql "$maintenance" -X -v ON_ERROR_STOP=1 -c "drop database if exists $database" -c "create database $database"
cleanup(){ psql "$maintenance" -X -v ON_ERROR_STOP=1 -c "alter database $database allow_connections true" -c "drop database if exists $database" >/dev/null;};trap cleanup EXIT
if (recover(){ psql "$maintenance" -X -v ON_ERROR_STOP=1 -c "alter database $database allow_connections true" >/dev/null;};trap recover EXIT;psql "$maintenance" -X -v ON_ERROR_STOP=1 -c "revoke connect on database $database from public" -c "alter database $database allow_connections false";[[ $(psql "$maintenance" -X -Atqc "select datallowconn from pg_database where datname='$database'") == f ]];false);then echo "failure simulation unexpectedly succeeded" >&2;exit 1;fi
[[ $(psql "$maintenance" -X -Atqc "select datallowconn from pg_database where datname='$database'") == t ]]
cleanup;trap - EXIT
