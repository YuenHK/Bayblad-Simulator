#!/usr/bin/env bash
set -euo pipefail
die(){ echo "first installation claim refused: $1" >&2;exit 1;}
[[ $# -eq 3 && $1 =~ ^[a-f0-9]{64}$ && $2 =~ ^[a-f0-9]{64}$ && $3 =~ ^[a-f0-9]{64}$ ]]||die "HOST_ID BOOTSTRAP_DIGEST AUTHORIZATION_NONCE required"
: "${PGSERVICE:?}";host=$1;digest=$2;nonce=$3
psql -X -v ON_ERROR_STOP=1 -q -v host="$host" -v digest="$digest" -v nonce="$nonce" <<'SQL' >/dev/null
begin;select pg_advisory_xact_lock(1937002752);
-- database is not pristine => deliberate transaction failure below
select case when not exists(select 1 from restore_control.platform_installation where not(host_id=:'host' and bootstrap_digest=:'digest' and authorization_nonce=:'nonce')) then 1 else 1/0 end;
select case when exists(select 1 from restore_control.platform_installation) or ((select count(*) from restore_control.finalize_outbox)+(select count(*) from deletion_audit)+(select count(*) from battle_results)+(select count(*) from matches)+(select count(*) from admin_audit)+(select count(*) from designs)+(select count(*) from identities)=0 and not exists(select 1 from restore_control.deployment_environment where singleton and environment='production')) then 1 else 1/0 end;
insert into restore_control.platform_installation(host_id,bootstrap_digest,authorization_nonce) values(:'host',:'digest',:'nonce') on conflict(singleton) do nothing;
select case when exists(select 1 from restore_control.platform_installation where host_id=:'host' and bootstrap_digest=:'digest' and authorization_nonce=:'nonce') then 1 else 1/0 end;commit;
SQL
