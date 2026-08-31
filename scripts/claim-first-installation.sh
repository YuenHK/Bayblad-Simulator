#!/usr/bin/env bash
set -euo pipefail
die(){ echo "first installation claim refused: $1" >&2;exit 1;}
[[ $# -eq 3 && $1 =~ ^[a-f0-9]{64}$ && $2 =~ ^[a-f0-9]{64}$ && $3 =~ ^[a-f0-9]{64}$ ]]||die "HOST_ID BOOTSTRAP_DIGEST AUTHORIZATION_NONCE required"
: "${PGSERVICE:?}";host=$1;digest=$2;nonce=$3
script_dir=$(CDPATH= cd -- "$(dirname "$0")"&&pwd -P);catalog_sql=$script_dir/assert-restore-control-catalog.sql;[[ -f $catalog_sql && ! -L $catalog_sql ]]||die "catalog authority missing"
root=$(CDPATH= cd -- "$script_dir/.."&&pwd -P);read -r protect_sha deletion_sha pristine_sha < <(node "$script_dir/derive-restore-function-hashes.mjs" "$root/drizzle/0000_steam_top_pre_first_deploy.sql" "$root/drizzle/0001_cutover_state_machine.sql" "$root/drizzle/0002_platform_installation.sql");for value in "$protect_sha" "$deletion_sha" "$pristine_sha";do [[ $value =~ ^[a-f0-9]{64}$ ]]||die "canonical function hash";done
{ cat <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);select set_config('steam_top.expected_platform_migration_sha','55a06f26947827ec40a29068fb17cd91a02b2085acaca15a1b2bb95f63c5aefb',true);select set_config('steam_top.expected_protect_function_sha',:'protect_sha',true),set_config('steam_top.expected_deletion_function_sha',:'deletion_sha',true),set_config('steam_top.expected_pristine_function_sha',:'pristine_sha',true);
SQL
cat "$catalog_sql"
cat <<'SQL'
lock table restore_control.deployment_environment in exclusive mode;
select case when count(*)=1 then 1 else 1/0 end from restore_control.deployment_environment where singleton;
lock table restore_control.platform_installation in exclusive mode;
lock table restore_control.promotion_outbox in exclusive mode;
lock table restore_control.promotion_audit in exclusive mode;
lock table restore_control.finalize_outbox in exclusive mode;
-- database is not pristine => deliberate transaction failure below
select case when not exists(select 1 from restore_control.platform_installation where not(host_id=:'host' and bootstrap_digest=:'digest' and authorization_nonce=:'nonce')) then 1 else 1/0 end;
select restore_control.assert_pristine_platform_installation() where not exists(select 1 from restore_control.platform_installation);
insert into restore_control.platform_installation(host_id,bootstrap_digest,authorization_nonce) values(:'host',:'digest',:'nonce') on conflict(singleton) do nothing;
select case when exists(select 1 from restore_control.platform_installation where host_id=:'host' and bootstrap_digest=:'digest' and authorization_nonce=:'nonce') then 1 else 1/0 end;commit;
SQL
} | psql -X -v ON_ERROR_STOP=1 -q -v host="$host" -v digest="$digest" -v nonce="$nonce" -v protect_sha="$protect_sha" -v deletion_sha="$deletion_sha" -v pristine_sha="$pristine_sha" >/dev/null
