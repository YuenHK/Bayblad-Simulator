#!/usr/bin/env bash
set -euo pipefail
exec 3>&1;exec 1>&2
die(){ echo "host deployment refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 8 ]]||die "root and eight arguments required";artifact=$1;env_file=$2;manifest_sha=$3;repository=$4;commit=$5;nonce=$6;expected_state=$7;deployment_id=$8
script_path=$(realpath "$0");script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/.."&&pwd -P);source "$root/infra/backup/host-trust-guard.sh"
[[ $script_path == /opt/steam-top/scripts/host-deploy-and-receipt.sh || $script_path =~ ^/opt/steam-top/releases/[a-f0-9]{64}/scripts/host-deploy-and-receipt\.sh$ ]]||die "installed canonical path required";backup_trusted_root_deployment "$root" "$script_dir" "$root/infra/backup"||die "installed deployment trust";backup_root_file_mode "$script_path" 555||die "installed script mode"
for name in HOST_RECEIPT_SIGNING_KEY PRODUCTION_AUTHORIZATION_DIR DEPLOYMENT_AUTHORIZATION_PURPOSE HOST_RECEIPT_PGSERVICE ADMIN_SMOKE_SECRET_FILE PGSERVICEFILE PGPASSFILE HOST_RECEIPT_OUTBOX_DIR;do [[ -n ${!name:-} ]]||die "$name required";done
case $DEPLOYMENT_AUTHORIZATION_PURPOSE in production|release-integration);;*) die "authorization purpose";;esac
for private in "$HOST_RECEIPT_SIGNING_KEY" "$ADMIN_SMOKE_SECRET_FILE" "$PGSERVICEFILE" "$PGPASSFILE";do backup_private_file "$private"||die "private file trust";done;backup_reject_libpq_overrides HOST_RECEIPT_PGSERVICE||die "libpq boundary"
[[ $nonce =~ ^[a-f0-9]{64}$ && $expected_state =~ ^(none|[1-9][0-9]*\|[a-f0-9]{64})$ && $deployment_id =~ ^[1-9][0-9]*$ ]]||die "state binding";[[ -d $HOST_RECEIPT_OUTBOX_DIR && ! -L $HOST_RECEIPT_OUTBOX_DIR ]]||die "outbox";read -r out_owner out_mode < <(stat -c '%u %a' "$HOST_RECEIPT_OUTBOX_DIR");[[ $out_owner == 0 && $out_mode == 700 ]]||die "outbox mode"
if [[ $DEPLOYMENT_AUTHORIZATION_PURPOSE == production ]];then lock=/var/lock/steam-top-production.lock;else lock=/var/lock/steam-top-release-integration.lock;fi;[[ -f $lock && ! -L $lock ]]||die "precreated lock required";read -r lock_owner lock_mode < <(stat -c '%u %a' "$lock");[[ $lock_owner == 0 && $lock_mode == 600 ]]||die "lock mode";command -v flock >/dev/null||die "Linux flock required";exec 9<>"$lock";flock -n 9||exit 75
tmp=$(mktemp -d);receipt="$HOST_RECEIPT_OUTBOX_DIR/$nonce.json";signature="$receipt.sig";phase=pending;cleanup(){ rm -rf "$tmp";};trap cleanup EXIT INT TERM
ledger="$HOST_RECEIPT_OUTBOX_DIR/deployment-ledger.json";ledger_signature="$ledger.sig"
if [[ -e $ledger || -e $ledger_signature ]];then
  [[ -f $ledger && ! -L $ledger && -f $ledger_signature && ! -L $ledger_signature ]]||die "host ledger incomplete";backup_root_file_mode "$ledger" 400||die "host ledger trust";backup_root_file_mode "$ledger_signature" 400||die "host ledger signature trust"
  ssh-keygen -Y verify -q -f <(printf 'host %s\n' "$(ssh-keygen -y -f "$HOST_RECEIPT_SIGNING_KEY")") -I host -n steam-top-host-deployment-ledger -s "$ledger_signature" <"$ledger"||die "host ledger signature"
  ledger_state=$(node -e 'const x=require(process.argv[1]);if(x.schemaVersion!==1||x.purpose!=="steam-top-host-deployment-ledger"||!/^[1-9][0-9]*$/.test(x.deploymentId)||!/^[a-f0-9]{64}$/.test(x.manifestSha256)||!/^[a-f0-9]{64}$/.test(x.receiptSha256))process.exit(1);process.stdout.write(`${x.deploymentId}|${x.manifestSha256}`)' "$ledger")||die "host ledger schema"
else ledger_state=none;fi
[[ $ledger_state == "$expected_state" ]]||die "expected predecessor differs from host ledger"
[[ -d $PRODUCTION_AUTHORIZATION_DIR && ! -L $PRODUCTION_AUTHORIZATION_DIR ]]||die "authorization directory";read -r auth_owner auth_mode < <(stat -c '%u %a' "$PRODUCTION_AUTHORIZATION_DIR");[[ $auth_owner == 0 && $auth_mode == 700 ]]||die "authorization directory trust"
authorization="$PRODUCTION_AUTHORIZATION_DIR/$nonce.json";consumed="$authorization.consumed";[[ -f $authorization && ! -L $authorization && ! -e $consumed ]]||die "authorization missing or already consumed";backup_root_file_mode "$authorization" 400||die "authorization trust"
RUNTIME_INSTALL_MANIFEST_SHA256=$(node -e 'process.stdout.write(require(process.argv[1]).runtimeManifestSha256??"")' "$authorization");export RUNTIME_INSTALL_MANIFEST_SHA256;"$script_dir/verify-runtime-install.sh" "$root"||die "runtime install trust"
node - "$authorization" "$DEPLOYMENT_AUTHORIZATION_PURPOSE" "$repository" "$deployment_id" "$nonce" "$manifest_sha" "$commit" "$expected_state" <<'NODE'
const a=require(process.argv[2]);if(a.schemaVersion!==2||!["pending","deploying","receipt-ready"].includes(a.state)||a.purpose!==process.argv[3]||a.repository!==process.argv[4]||a.deploymentId!==process.argv[5]||a.nonce!==process.argv[6]||a.manifestSha256!==process.argv[7]||!/^[a-f0-9]{64}$/.test(a.runtimeManifestSha256)||a.commit!==process.argv[8]||a.expectedPreviousState!==process.argv[9])process.exit(1);
NODE
auth_state(){ local state=$1 baseline=${2:-} next="$authorization.tmp.$$";node - "$authorization" "$state" "$baseline" "$next" <<'NODE'
const fs=require("fs"),a=JSON.parse(fs.readFileSync(process.argv[2]));a.state=process.argv[3];if(process.argv[4])a.baselineServices=JSON.parse(fs.readFileSync(process.argv[4]));a.stateChangedAt=new Date().toISOString();fs.writeFileSync(process.argv[5],JSON.stringify(a)+"\n",{flag:"wx",mode:0o400});
NODE
chmod 400 "$next";mv "$next" "$authorization";}
emit_receipt(){ printf 'RECEIPT-BEGIN %s\n' "$nonce" >&3;base64 <"$receipt" >&3;printf 'RECEIPT-SIGNATURE\n' >&3;base64 <"$signature" >&3;printf 'RECEIPT-END %s\n' "$nonce" >&3;}
advance_deployment_ledger(){
  if [[ -f $ledger ]];then current=$(node -e 'const x=require(process.argv[1]);process.stdout.write(`${x.deploymentId}|${x.manifestSha256}`)' "$ledger");[[ $current == "$deployment_id|$manifest_sha" ]]&&return 0;[[ $current == "$expected_state" ]]||die "ledger already advanced by another deployment";else [[ $expected_state == none ]]||die "ledger already advanced by another deployment";fi
  receipt_sha=$($script_dir/portable-sha256.sh digest "$receipt");next="$ledger.tmp.$$";node - "$next" "$deployment_id" "$manifest_sha" "$receipt_sha" "$nonce" "$expected_state" <<'NODE'
const fs=require("fs"),[path,id,manifest,receipt,nonce,previous]=process.argv.slice(2);fs.writeFileSync(path,JSON.stringify({schemaVersion:1,purpose:"steam-top-host-deployment-ledger",deploymentId:id,manifestSha256:manifest,receiptSha256:receipt,nonce,previousState:previous,advancedAt:new Date().toISOString()})+"\n",{flag:"wx",mode:0o400});
NODE
  ssh-keygen -Y sign -q -f "$HOST_RECEIPT_SIGNING_KEY" -n steam-top-host-deployment-ledger "$next";chmod 400 "$next" "$next.sig";mv "$next" "$ledger";mv "$next.sig" "$ledger_signature"
}
current_state=$(node -e 'process.stdout.write(require(process.argv[1]).state)' "$authorization");if [[ $current_state == receipt-ready ]];then [[ -f $receipt && ! -L $receipt && -f $signature && ! -L $signature ]]||die "receipt-ready outbox incomplete";advance_deployment_ledger;emit_receipt;auth_state consumed;mv "$authorization" "$consumed";exit 0;fi
node "$script_dir/production-env.mjs" "$env_file" "$tmp/env";origin=$(sed -n 's/^PUBLIC_ORIGIN=//p' "$tmp/env");server_ref=$(sed -n 's/^SERVER_IMAGE=//p' "$tmp/env");web_ref=$(sed -n 's/^WEB_IMAGE=//p' "$tmp/env");db_ref=$(sed -n 's/^DATABASE_IMAGE=//p' "$tmp/env");caddy_repo=$(sed -n 's/^CADDY_IMAGE_REPOSITORY=//p' "$tmp/env");caddy_digest=$(sed -n 's/^CADDY_IMAGE_DIGEST=//p' "$tmp/env");caddy_ref="$caddy_repo@$caddy_digest"
case $DEPLOYMENT_AUTHORIZATION_PURPOSE in production) compose=(docker compose --project-directory "$root" --env-file "$tmp/env" -f "$root/compose.yaml");;release-integration) compose=(docker compose -p steam-top-release-integration --project-directory "$root" --env-file "$tmp/env" -f "$root/compose.yaml" -f "$root/compose.release-integration.yaml");;esac
incident(){ local reason=$1 path="$HOST_RECEIPT_OUTBOX_DIR/$nonce.RECOVERY-REQUIRED";node - "$path" "$nonce" "$deployment_id" "$reason" <<'NODE'
const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,purpose:"deployment-recovery-required",nonce:process.argv[3],deploymentId:process.argv[4],reason:process.argv[5],createdAt:new Date().toISOString()})+"\n",{flag:"wx",mode:0o600});
NODE
chmod 600 "$path";auth_state failed;phase=failed;}
[[ ! -e $receipt && ! -e $signature ]]||die "unexpected partial outbox";should_deploy=true
if [[ $current_state == deploying ]];then
  phase=deploying;ids=$("${compose[@]}" ps -aq);if [[ -n $ids ]];then docker inspect $ids >"$tmp/retry-containers.json"||{ incident "container inspection failed";die "partial deployment observed";};else printf '[]\n' >"$tmp/retry-containers.json";fi
  node "$script_dir/fingerprint-host-baseline.mjs" "$tmp/retry-containers.json" "$DEPLOYMENT_AUTHORIZATION_PURPOSE" "$tmp/retry-baseline.json"||{ incident "invalid retry service set";die "partial deployment observed";}
  baseline_equal=$(node - "$authorization" "$tmp/retry-baseline.json" <<'NODE'
const a=require(process.argv[2]),b=require(process.argv[3]);process.stdout.write(JSON.stringify(a.baselineServices)===JSON.stringify(b)?"true":"false");
NODE
)
  if [[ $baseline_equal == true ]];then should_deploy=true
  elif [[ -n $ids ]];then
    if ! docker image inspect "$server_ref" "$web_ref" "$db_ref" "$caddy_ref" >"$tmp/retry-images.json";then incident "immutable image inspection failed";die "partial deployment observed";fi
    node "$script_dir/classify-host-deployment.mjs" "$artifact/release-manifest.json" "$tmp/retry-containers.json" "$tmp/retry-images.json" "$caddy_ref" "$DEPLOYMENT_AUTHORIZATION_PURPOSE" "$tmp/retry-classification.json"
    classification=$(node -e 'process.stdout.write(require(process.argv[1]).classification)' "$tmp/retry-classification.json");if [[ $classification != complete ]];then incident "partial or mismatched services";die "partial deployment observed";fi
    should_deploy=false
  else incident "services differ from deploy baseline and target";die "partial deployment observed";fi
else
  ids=$("${compose[@]}" ps -aq);if [[ -n $ids ]];then docker inspect $ids >"$tmp/baseline-containers.json"||die "baseline inspection";else printf '[]\n' >"$tmp/baseline-containers.json";fi
  node "$script_dir/fingerprint-host-baseline.mjs" "$tmp/baseline-containers.json" "$DEPLOYMENT_AUTHORIZATION_PURPOSE" "$tmp/baseline.json"||{ incident "unsafe pre-deploy baseline";die "partial deployment observed";}
  auth_state deploying "$tmp/baseline.json";phase=deploying
fi
if [[ $should_deploy == true ]];then "$script_dir/deploy-production.sh" "$artifact" "$env_file" "$manifest_sha" "$repository" "$commit";fi
PGSERVICE=$HOST_RECEIPT_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);create table if not exists restore_control.deployment_probe(nonce text primary key check(nonce~'^[a-f0-9]{64}$'),restore_target_id uuid not null,system_identifier text not null,created_at timestamptz not null default clock_timestamp(),consumed_at timestamptz);alter table restore_control.deployment_probe add column if not exists state text not null default 'pending';alter table restore_control.deployment_probe add column if not exists observed_at timestamptz;alter table restore_control.deployment_probe add column if not exists receipt_signed_at timestamptz;insert into restore_control.deployment_probe(nonce,restore_target_id,system_identifier,state)select :'nonce',restore_target_id,(select system_identifier::text from pg_control_system()),'pending' from restore_control.deployment_environment where singleton on conflict(nonce) do nothing;commit;
SQL
if [[ $DEPLOYMENT_AUTHORIZATION_PURPOSE == release-integration ]];then smoke_mode=true;else smoke_mode=false;fi
probe_state=$(PGSERVICE=$HOST_RECEIPT_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -Atqc "select p.state from restore_control.deployment_probe p join restore_control.deployment_environment e on e.singleton and e.restore_target_id=p.restore_target_id where p.nonce=:'nonce' and p.system_identifier=(select system_identifier::text from pg_control_system())");if [[ $probe_state == pending ]];then probe_observed=false;elif [[ $probe_state =~ ^(public-observed|receipt-signed|consumed)$ ]];then probe_observed=true;else die "probe outbox state or binding";fi
SMOKE_INTEGRATION_MODE=$smoke_mode PRODUCTION_SMOKE_PROBE_ALREADY_OBSERVED=$probe_observed ADMIN_SMOKE_SECRET_FILE="$ADMIN_SMOKE_SECRET_FILE" "$script_dir/production-smoke.sh" "$origin" "$nonce"
PGSERVICE=$HOST_RECEIPT_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -c "update restore_control.deployment_probe set state='receipt-signed',receipt_signed_at=coalesce(receipt_signed_at,clock_timestamp()) where nonce=:'nonce' and state in ('public-observed','receipt-signed')" >/dev/null
ids=$("${compose[@]}" ps -aq);[[ -n $ids ]]||die "no containers";docker inspect $ids >"$tmp/containers.json";docker image inspect "$server_ref" "$web_ref" "$db_ref" "$caddy_ref" >"$tmp/images.json"
PGSERVICE=$HOST_RECEIPT_PGSERVICE psql -X -v ON_ERROR_STOP=1 -AtF '|' -c "select (select system_identifier from pg_control_system()),current_database(),environment,restore_allowed,restore_target_id from restore_control.deployment_environment where singleton"|node -e 'const fs=require("fs"),s=fs.readFileSync(0,"utf8").trim().split("|");if(s.length!==5)process.exit(1);fs.writeFileSync(process.argv[1],JSON.stringify({systemIdentifier:s[0],database:s[1],markerEnvironment:s[2],restoreAllowed:s[3]==="t",restoreTargetId:s[4]})+"\n")' "$tmp/database.json"
node "$script_dir/create-host-deployment-receipt.mjs" "$artifact/release-manifest.json" "$tmp/containers.json" "$tmp/images.json" "$tmp/database.json" "$caddy_ref" "$manifest_sha" "$commit" "$nonce" "$origin" "$receipt";ssh-keygen -Y sign -q -f "$HOST_RECEIPT_SIGNING_KEY" -n steam-top-production-deployment "$receipt";chmod 400 "$receipt" "$signature";advance_deployment_ledger;auth_state receipt-ready;phase=receipt-ready
emit_receipt;PGSERVICE=$HOST_RECEIPT_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -c "update restore_control.deployment_probe set state='consumed',consumed_at=coalesce(consumed_at,clock_timestamp()) where nonce=:'nonce' and state in ('receipt-signed','consumed')" >/dev/null;auth_state consumed;mv "$authorization" "$consumed";phase=consumed
