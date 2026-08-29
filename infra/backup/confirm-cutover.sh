#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover confirmation refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 5 && ${CANONICAL_STATE_RESOLVED:-} == true ]]||die "canonical root wrapper required"
ready=$1;preflight=$2;preflight_sig=$3;smoke_probe=$4;final=$5;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE CUTOVER_SIGNING_KEY CUTOVER_ALLOWED_SIGNERS_FILE CUTOVER_SIGNER_ID;do [[ -n ${!name:-} ]]||die "$name required";done
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq overrides";backup_trusted_root_deployment "$root" "$script_dir" "$root/scripts"||die "host trust";source "$root/scripts/key-custody-guard.sh";key_signer_matches_allowed "$CUTOVER_SIGNING_KEY" "$CUTOVER_ALLOWED_SIGNERS_FILE" "$CUTOVER_SIGNER_ID"||die "smoke signer mapping"
for file in "$ready" "$ready.sha256" "$preflight" "$preflight_sig" "$smoke_probe";do [[ $file == /* && -f $file && ! -L $file ]]||die "unsafe input";done
ssh-keygen -Y verify -q -f "$CUTOVER_ALLOWED_SIGNERS_FILE" -I "$CUTOVER_SIGNER_ID" -n steam-top-cutover-preflight -s "$preflight_sig" <"$preflight"||die "preflight signature"
values=$(node - "$ready" "$preflight" "$smoke_probe" <<'NODE'
const r=require(process.argv[2]),p=require(process.argv[3]),s=require(process.argv[4]);if(p.purpose!=="production-cutover-preflight"||p.promotionNonce!==r.promotionNonce||s.nonce!==r.promotionNonce||s.restoreTargetId!==r.restoreTargetId||s.systemIdentifier!==r.systemIdentifier)process.exit(1);console.log([r.promotionNonce,r.appRole,r.restoreTargetId,r.ledgerRows].join("|"));
NODE
)||die "public smoke binding";IFS='|' read -r nonce role target rows <<EOF
$values
EOF
PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -v role="$role" -v target="$target" -v rows="$rows" <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);
select case when exists(select 1 from restore_control.finalize_outbox where nonce=:'nonce' and state='connect-granted-pending-smoke' and restore_target_id=:'target'::uuid and app_role=:'role' and ledger_rows=:'rows'::bigint) and exists(select 1 from restore_control.deployment_probe where nonce=:'nonce' and state='public-observed' and restore_target_id=:'target'::uuid) then 1 else 1/0 end;
update restore_control.finalize_outbox set state='verified' where nonce=:'nonce' and state='connect-granted-pending-smoke';
update restore_control.promotion_audit set finalized_at=coalesce(finalized_at,clock_timestamp()) where cutover_nonce=:'nonce';
update restore_control.deployment_probe set state='consumed',consumed_at=coalesce(consumed_at,clock_timestamp()) where nonce=:'nonce';commit;
SQL
node - "$preflight" "$smoke_probe" "$final" <<'NODE'
const fs=require("fs"),crypto=require("crypto"),p=require(process.argv[2]),s=require(process.argv[3]);fs.writeFileSync(process.argv[4],JSON.stringify({schemaVersion:1,purpose:"production-cutover-verified",promotionNonce:p.promotionNonce,publicOrigin:p.publicOrigin,systemIdentifier:p.systemIdentifier,restoreTargetId:p.restoreTargetId,preflightSha256:crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex"),smokeProbe:s,verifiedAt:new Date().toISOString()},null,2)+"\n",{flag:"wx",mode:0o400});
NODE
ssh-keygen -Y sign -q -f "$CUTOVER_SIGNING_KEY" -n steam-top-public-cutover-smoke "$final";chmod 400 "$final.sig";ssh-keygen -Y verify -q -f "$CUTOVER_ALLOWED_SIGNERS_FILE" -I "$CUTOVER_SIGNER_ID" -n steam-top-public-cutover-smoke -s "$final.sig" <"$final"||die "final post-sign verify"
