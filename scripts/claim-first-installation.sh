#!/usr/bin/env bash
set -euo pipefail
die(){ echo "first installation claim refused: $1" >&2;exit 1;}
[[ $# -eq 3 && $1 =~ ^[a-f0-9]{64}$ && $2 =~ ^[a-f0-9]{64}$ && $3 =~ ^[a-f0-9]{64}$ ]]||die "HOST_ID BOOTSTRAP_DIGEST AUTHORIZATION_NONCE required"
: "${PGSERVICE:?}";host=$1;digest=$2;nonce=$3
psql -X -v ON_ERROR_STOP=1 -q -v host="$host" -v digest="$digest" -v nonce="$nonce" <<'SQL' >/dev/null
begin;select pg_advisory_xact_lock(1937002751);select set_config('steam_top.expected_platform_migration_sha','cb3dc38371bfaa56d14feb2f286be8dbeafc3dfe206dd0941d862973d7b60c62',true);
lock table restore_control.deployment_environment in exclusive mode;
select case when count(*)=1 then 1 else 1/0 end from restore_control.deployment_environment where singleton for update;
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
