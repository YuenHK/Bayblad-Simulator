#!/usr/bin/env bash
set -euo pipefail
die(){ echo "legacy cutover import refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 5 && $1 =~ ^[a-f0-9]{64}$ ]]||die "root nonce receipt signature allowed-signers signer-id required"
nonce=$1;receipt=$2;signature=$3;allowed=$4;signer=$5;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE;do [[ -n ${!name:-} ]]||die "$name required";done;backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq overrides"
for file in "$receipt" "$signature" "$allowed";do [[ $file == /* && -f $file && ! -L $file ]]&&backup_root_file_mode "$file" 400||die "legacy evidence trust";done
ssh-keygen -Y verify -q -f "$allowed" -I "$signer" -n steam-top-public-cutover-smoke -s "$signature" <"$receipt"||die "legacy receipt signature"
node - "$receipt" "$nonce" <<'NODE'
const r=require(process.argv[2]);if(r.schemaVersion!==1||r.purpose!=="production-cutover-verified"||r.promotionNonce!==process.argv[3]||!/^[a-f0-9]{64}$/.test(r.preflightSha256)||!Number.isFinite(Date.parse(r.verifiedAt)))process.exit(1);
NODE
PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);select case when exists(select 1 from restore_control.finalize_outbox where nonce=:'nonce' and state='legacy-committed' for update) then 1 else 1/0 end;update restore_control.finalize_outbox set state='verified',verified_at=coalesce(verified_at,clock_timestamp()) where nonce=:'nonce' and state='legacy-committed';commit;
SQL
