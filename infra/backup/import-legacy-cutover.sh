#!/usr/bin/env bash
set -euo pipefail
die(){ echo "legacy cutover import refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 9 && $1 =~ ^[a-f0-9]{64}$ && ${CANONICAL_STATE_RESOLVED:-} == true ]]||die "canonical root legacy evidence required"
nonce=$1;receipt=$2;receipt_sig=$3;ready=$4;ready_sha_file=$5;preflight=$6;preflight_sig=$7;allowed=$8;signer=$9
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh";source "$root/scripts/key-custody-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE RUNTIME_INSTALL_MANIFEST_SHA256;do [[ -n ${!name:-} ]]||die "$name required";done
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq overrides";backup_trusted_root_deployment "$root" "$script_dir" "$root/scripts"||die "runtime trust";"$root/scripts/verify-runtime-install.sh" "$root"||die "runtime seal"
for file in "$receipt" "$receipt_sig" "$ready" "$ready_sha_file" "$preflight" "$preflight_sig";do [[ $file == /* && -f $file && ! -L $file ]]&&backup_root_file_mode "$file" 400||die "legacy evidence trust";done
key_allowed_signers_file "$allowed"||die "legacy signer trust"
ssh-keygen -Y verify -q -f "$allowed" -I "$signer" -n steam-top-cutover -s "$receipt_sig" <"$receipt"||die "legacy receipt signature"
ssh-keygen -Y verify -q -f "$allowed" -I "$signer" -n steam-top-cutover-preflight -s "$preflight_sig" <"$preflight"||die "legacy preflight signature"
ready_sha=$("$root/scripts/portable-sha256.sh" digest "$ready");[[ $(<"$ready_sha_file") == "$ready_sha" ]]||die "legacy ready digest";preflight_sha=$("$root/scripts/portable-sha256.sh" digest "$preflight")
values=$(node "$root/scripts/validate-legacy-cutover-evidence.mjs" "$receipt" "$ready" "$preflight" "$nonce" "$preflight_sha")||die "legacy evidence binding";IFS='|' read -r target system database role rows <<EOF
$values
EOF
encode(){ node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("base64"))' "$1";};payload=$(encode "$receipt");signature_b64=$(encode "$receipt_sig");digest=$("$root/scripts/portable-sha256.sh" digest "$receipt");ready_b64=$(encode "$ready");ready_sig_b64=$(encode "$ready_sha_file");preflight_b64=$(encode "$preflight");preflight_sig_b64=$(encode "$preflight_sig")
PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -v target="$target" -v system="$system" -v database="$database" -v role="$role" -v rows="$rows" -v payload="$payload" -v signature="$signature_b64" -v digest="$digest" -v signer="$signer" -v ready_b64="$ready_b64" -v ready_sha="$ready_sha" -v ready_sig_b64="$ready_sig_b64" -v preflight_b64="$preflight_b64" -v preflight_sha="$preflight_sha" -v preflight_sig_b64="$preflight_sig_b64" <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);
select case when exists(select 1 from restore_control.finalize_outbox where nonce=:'nonce' and state='legacy-committed' and restore_target_id=:'target'::uuid and app_role=:'role' and ledger_rows=:'rows'::bigint for update) and (select system_identifier::text from pg_control_system())=:'system' and current_database()=:'database' and exists(select 1 from restore_control.deployment_environment where singleton and environment='production' and not restore_allowed and restore_target_id=:'target'::uuid) and (select count(*) from deletion_audit)=:'rows'::bigint then 1 else 1/0 end;
update restore_control.finalize_outbox set state='verified',system_identifier=:'system',database_name=:'database',ledger_hash=restore_control.deletion_audit_sha256(),verified_at=coalesce(verified_at,clock_timestamp()),final_receipt=convert_from(decode(:'payload','base64'),'UTF8')::jsonb,final_receipt_payload_b64=:'payload',final_receipt_sha256=:'digest',final_receipt_signature_b64=:'signature',final_receipt_signer_id=:'signer',legacy_ready_payload_b64=:'ready_b64',legacy_ready_sha256=:'ready_sha',legacy_ready_sha_file_b64=:'ready_sig_b64',legacy_ready_signer_id=:'signer',legacy_preflight_payload_b64=:'preflight_b64',legacy_preflight_sha256=:'preflight_sha',legacy_preflight_signature_b64=:'preflight_sig_b64',legacy_preflight_signer_id=:'signer' where nonce=:'nonce' and state='legacy-committed';commit;
SQL
