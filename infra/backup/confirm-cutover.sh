#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover confirmation refused: $1" >&2;exit 1;}
psql(){ command psql -q "$@";}
[[ $(id -u) -eq 0 && ( $# -eq 4 || $# -eq 5 ) && ${CANONICAL_STATE_RESOLVED:-} == true ]]||die "canonical root wrapper required"
ready=$1;preflight=$2;preflight_sig=$3;if [[ $# -eq 5 ]];then smoke_probe=$4;final=$5;else smoke_probe=;final=$4;fi;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE PROMOTE_STATE_DIR CUTOVER_SIGNING_KEY CUTOVER_ALLOWED_SIGNERS_FILE CUTOVER_SIGNER_ID;do [[ -n ${!name:-} ]]||die "$name required";done
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq overrides";backup_trusted_root_deployment "$root" "$script_dir" "$root/scripts"||die "host trust";source "$root/scripts/key-custody-guard.sh";key_signer_matches_allowed "$CUTOVER_SIGNING_KEY" "$CUTOVER_ALLOWED_SIGNERS_FILE" "$CUTOVER_SIGNER_ID"||die "smoke signer mapping"
[[ $final == /* && ! -L $final && ! -L $final.sig ]]||die "unsafe final output";final_dir=$(dirname "$final");[[ -d $final_dir && ! -L $final_dir && $(realpath "$final_dir") == $(realpath "$PROMOTE_STATE_DIR") ]]||die "final directory";read -r final_owner final_mode < <(stat -c '%u %a' "$final_dir");[[ $final_owner == 0 && $final_mode == 700 ]]&&key_trusted_parents "$final"||die "final directory custody";for existing_output in "$final" "$final.sig";do if [[ -e $existing_output ]];then backup_root_file_mode "$existing_output" 400||die "existing final output trust";fi;done
for file in "$ready" "$ready.sha256" "$preflight" "$preflight_sig";do [[ $file == /* && -f $file && ! -L $file ]]||die "unsafe input";backup_root_file_mode "$file" 400||die "input trust";done
[[ $("$root/scripts/portable-sha256.sh" digest "$ready") == "$(<"$ready.sha256")" ]]||die "ready digest"
ssh-keygen -Y verify -q -f "$CUTOVER_ALLOWED_SIGNERS_FILE" -I "$CUTOVER_SIGNER_ID" -n steam-top-cutover-preflight -s "$preflight_sig" <"$preflight"||die "preflight signature"
publish_tmp=$(mktemp -d "$final_dir/.confirm.XXXXXX");chmod 700 "$publish_tmp";smoke_probe_owned=false;cleanup_confirm(){ rm -rf "$publish_tmp";[[ $smoke_probe_owned == false ]]||rm -f "$smoke_probe";};trap cleanup_confirm EXIT
if [[ -z $smoke_probe ]];then nonce_for_rebuild=$(node -p 'require(process.argv[1]).promotionNonce' "$ready");encoded=$(PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -At -v nonce="$nonce_for_rebuild" -c "select smoke_evidence_payload_b64 from restore_control.finalize_outbox where nonce=:'nonce' and state in ('smoke-observed','verified')");[[ -n $encoded ]]||die "durable smoke evidence unavailable";smoke_probe=$(mktemp);smoke_probe_owned=true;node -e 'require("fs").writeFileSync(process.argv[2],Buffer.from(process.argv[1],"base64"))' "$encoded" "$smoke_probe";chmod 400 "$smoke_probe";fi
[[ $smoke_probe == /* && -f $smoke_probe && ! -L $smoke_probe ]]&&backup_root_file_mode "$smoke_probe" 400||die "smoke evidence trust"
values=$(node - "$ready" "$preflight" "$smoke_probe" <<'NODE'
const r=require(process.argv[2]),p=require(process.argv[3]),s=require(process.argv[4]);if(p.purpose!=="production-cutover-preflight"||p.promotionNonce!==r.promotionNonce||s.nonce!==r.promotionNonce||s.restoreTargetId!==r.restoreTargetId||s.systemIdentifier!==r.systemIdentifier)process.exit(1);console.log([r.promotionNonce,r.appRole,r.restoreTargetId,r.ledgerRows].join("|"));
NODE
)||die "public smoke binding";IFS='|' read -r nonce role target rows <<EOF
$values
EOF
expected="$publish_tmp/final.json";node - "$preflight" "$smoke_probe" "$expected" <<'NODE'
const fs=require("fs"),crypto=require("crypto"),p=require(process.argv[2]),s=require(process.argv[3]);fs.writeFileSync(process.argv[4],JSON.stringify({schemaVersion:1,purpose:"production-cutover-verified",promotionNonce:p.promotionNonce,publicOrigin:p.publicOrigin,systemIdentifier:p.systemIdentifier,restoreTargetId:p.restoreTargetId,preflightSha256:crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex"),smokeProbe:s,verifiedAt:new Date(s.createdAt).toISOString()},null,2)+"\n",{flag:"wx",mode:0o400});
NODE
node -e 'const fs=require("fs"),fd=fs.openSync(process.argv[1],"r");fs.fsyncSync(fd);fs.closeSync(fd)' "$expected"
smoke_sha=$("$root/scripts/portable-sha256.sh" digest "$smoke_probe");final_sha=$("$root/scripts/portable-sha256.sh" digest "$expected");preflight_sha=$("$root/scripts/portable-sha256.sh" digest "$preflight");smoke_json=$(<"$smoke_probe");final_json=$(<"$expected");smoke_b64=$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("base64"))' "$smoke_probe");final_b64=$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("base64"))' "$expected")
existing=$(PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -AtF '|' -v nonce="$nonce" -c "select state,coalesce(final_receipt_sha256,''),coalesce(final_receipt_payload_b64,''),coalesce(final_receipt_signature_b64,''),coalesce(final_receipt_signer_id,'') from restore_control.finalize_outbox where nonce=:'nonce'")
IFS='|' read -r existing_state existing_sha existing_b64 existing_signature_b64 existing_signer <<EOF
$existing
EOF
if [[ $existing_state == smoke-observed || $existing_state == verified ]];then
  [[ $existing_sha == "$final_sha" && $existing_b64 == "$final_b64" ]]||die "stored final receipt conflict"
else
PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -v role="$role" -v target="$target" -v rows="$rows" -v smoke="$smoke_json" -v smoke_b64="$smoke_b64" -v smoke_sha="$smoke_sha" -v final="$final_json" -v final_sha="$final_sha" -v final_b64="$final_b64" -v preflight_sha="$preflight_sha" >/dev/null <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);
select case when exists(select 1 from restore_control.finalize_outbox where nonce=:'nonce' and state in ('connect-granted-pending-smoke','smoke-observed') and restore_target_id=:'target'::uuid and app_role=:'role' and ledger_rows=:'rows'::bigint and ledger_hash=restore_control.deletion_audit_sha256() and preflight_sha256=:'preflight_sha' for update) and exists(select 1 from restore_control.deployment_probe where nonce=:'nonce' and state='public-observed' and restore_target_id=:'target'::uuid) and (select system_identifier::text from pg_control_system())=(select system_identifier from restore_control.finalize_outbox where nonce=:'nonce') and current_database()=(select database_name from restore_control.finalize_outbox where nonce=:'nonce') and exists(select 1 from restore_control.deployment_environment where singleton and environment='production' and not restore_allowed and restore_target_id=:'target'::uuid) and has_database_privilege(:'role',current_database(),'connect') and not has_database_privilege('public',current_database(),'connect') and (select count(*) from deletion_audit)=:'rows'::bigint then 1 else 1/0 end;
update restore_control.finalize_outbox set state='smoke-observed',smoke_evidence=:'smoke'::jsonb,smoke_evidence_payload_b64=:'smoke_b64',smoke_evidence_sha256=:'smoke_sha',final_receipt=:'final'::jsonb,final_receipt_sha256=:'final_sha',final_receipt_payload_b64=:'final_b64',observed_at=coalesce(observed_at,clock_timestamp()) where nonce=:'nonce' and state='connect-granted-pending-smoke';commit;
SQL
fi
if [[ -f $final ]];then cmp -s "$expected" "$final"||die "final receipt conflict";payload_source=$final;else payload_source=$expected;fi
if [[ $existing_state == verified ]];then
  [[ -n $existing_signature_b64 && $existing_signer == "$CUTOVER_SIGNER_ID" ]]||die "verified receipt has no durable signature"
  signature_source="$publish_tmp/final.json.sig";node -e 'const fs=require("fs"),p=process.argv[2];fs.writeFileSync(p,Buffer.from(process.argv[1],"base64"),{flag:"wx",mode:0o400});const fd=fs.openSync(p,"r");fs.fsyncSync(fd);fs.closeSync(fd)' "$existing_signature_b64" "$signature_source";if [[ -f $final.sig ]];then cmp -s "$signature_source" "$final.sig"||die "stored signature conflict";rm -f "$signature_source";signature_source=$final.sig;fi
else
  if [[ -f $final.sig ]];then signature_source=$final.sig;else ssh-keygen -Y sign -q -f "$CUTOVER_SIGNING_KEY" -n steam-top-public-cutover-smoke "$payload_source";signature_source=$payload_source.sig;chmod 400 "$signature_source";fi
fi
ssh-keygen -Y verify -q -f "$CUTOVER_ALLOWED_SIGNERS_FILE" -I "$CUTOVER_SIGNER_ID" -n steam-top-public-cutover-smoke -s "$signature_source" <"$payload_source"||die "final post-sign verify"
if [[ ! -f $final ]];then mv "$expected" "$final";fi;if [[ ! -f $final.sig ]];then mv "$signature_source" "$final.sig";fi
[[ $existing_state == verified ]]&&exit 0
signature_b64=$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("base64"))' "$final.sig")
PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -v final_sha="$final_sha" -v final_b64="$final_b64" -v signature_b64="$signature_b64" -v signer="$CUTOVER_SIGNER_ID" -v role="$role" -v target="$target" -v rows="$rows" >/dev/null <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);select case when exists(select 1 from restore_control.finalize_outbox where nonce=:'nonce' and state='smoke-observed' and final_receipt_sha256=:'final_sha' and final_receipt_payload_b64=:'final_b64' and ledger_hash=restore_control.deletion_audit_sha256() for update) and has_database_privilege(:'role',current_database(),'connect') and not has_database_privilege('public',current_database(),'connect') and exists(select 1 from restore_control.deployment_environment where singleton and environment='production' and not restore_allowed and restore_target_id=:'target'::uuid) and (select count(*) from deletion_audit)=:'rows'::bigint then 1 else 1/0 end;update restore_control.finalize_outbox set state='verified',final_receipt_signature_b64=:'signature_b64',final_receipt_signer_id=:'signer',verified_at=coalesce(verified_at,clock_timestamp()),deadline_at=null where nonce=:'nonce' and state='smoke-observed';update restore_control.promotion_audit set finalized_at=coalesce(finalized_at,clock_timestamp()) where cutover_nonce=:'nonce';update restore_control.deployment_probe set state='consumed',consumed_at=coalesce(consumed_at,clock_timestamp()) where nonce=:'nonce';commit;
SQL
