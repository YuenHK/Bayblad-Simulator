#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover finalization refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 3 ]]||die "root and ready/receipt/signature paths required"
ready=$1;cutover=$2;signature=$3;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE CUTOVER_ALLOWED_SIGNERS_FILE CUTOVER_SIGNER_ID;do [[ -n ${!name:-} ]]||die "$name required";done
backup_reject_libpq_overrides PROMOTE_PGSERVICE||die "libpq overrides";for private in "$PGSERVICEFILE" "$PGPASSFILE" "$CUTOVER_ALLOWED_SIGNERS_FILE";do backup_private_file "$private"||die "private file trust";done;backup_trusted_root_deployment "$root" "$script_dir" "$root/apps/server/dist/admin" "$root/scripts"||die "host trust"
for file in "$ready" "$ready.sha256" "$cutover" "$signature";do [[ $file == /* && -f $file && ! -L $file ]]||die "state files unsafe";backup_root_file_mode "$file" 400||die "state file mode";done
[[ $("$root/scripts/portable-sha256.sh" digest "$ready") == "$(<"$ready.sha256")" ]]||die "ready digest mismatch";ssh-keygen -Y verify -q -f "$CUTOVER_ALLOWED_SIGNERS_FILE" -I "$CUTOVER_SIGNER_ID" -n steam-top-cutover -s "$signature" <"$cutover"||die "cutover signature"
values=$(node -e 'const fs=require("fs"),crypto=require("crypto"),r=JSON.parse(fs.readFileSync(process.argv[1])),c=JSON.parse(fs.readFileSync(process.argv[2])),d=crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");if(r.schemaVersion!==1||c.schemaVersion!==1||c.readySha256!==d||c.publicSmoke!=="passed"||c.systemIdentifier!==r.systemIdentifier||c.database!==r.database||c.appRole!==r.appRole||c.restoreTargetId!==r.restoreTargetId||c.ledgerRows!==r.ledgerRows)process.exit(1);console.log([r.systemIdentifier,r.database,r.appRole,r.restoreTargetId,r.ledgerRows,c.nonce].join("|"))' "$ready" "$cutover")||die "bound cutover receipt"
IFS='|' read -r system_id database role target_id ledger_rows nonce <<EOF
$values
EOF
[[ $database =~ ^[a-z_][a-z0-9_]{0,62}$ && $role =~ ^[a-z_][a-z0-9_]{0,62}$ && $ledger_rows =~ ^[0-9]+$ && $nonce =~ ^[a-f0-9]{64}$ ]]||die "identity"
export PGSERVICE=$PROMOTE_PGSERVICE
actual=$(psql -X -v ON_ERROR_STOP=1 -v target_id="$target_id" -v role="$role" -v expected_rows="$ledger_rows" -AtF '|' -c "select (select system_identifier from pg_control_system()),current_database(),exists(select 1 from restore_control.deployment_environment where singleton and environment='production' and not restore_allowed and restore_target_id=:'target_id'::uuid),has_database_privilege('public',current_database(),'connect'),has_database_privilege(:'role',current_database(),'connect'),(select count(*) from deletion_audit)=:'expected_rows'::bigint")
[[ $actual == "$system_id|$database|t|f|f|t" ]]||die "database marker, ledger, or ACL changed"
psql -X -v ON_ERROR_STOP=1 -v role="$role" -v target_id="$target_id" -v nonce="$nonce" -v ledger_rows="$ledger_rows" <<'SQL'
begin;
select pg_advisory_xact_lock(1937002751);
select format('grant connect on database %I to %I',current_database(),:'role') \gexec
create table if not exists restore_control.promotion_audit(id bigserial primary key,restore_target_id uuid not null,app_role text not null,cutover_nonce text not null unique,ledger_rows bigint not null,finalized_at timestamptz not null default clock_timestamp());
insert into restore_control.promotion_audit(restore_target_id,app_role,cutover_nonce,ledger_rows) values (:'target_id'::uuid,:'role',:'nonce',:'ledger_rows'::bigint);
commit;
SQL
stamp=$(date -u +%Y%m%dT%H%M%SZ);final="$ready.finalized.$stamp";[[ ! -e $final ]]||die "receipt exists";mv "$ready" "$final";mv "$ready.sha256" "$final.sha256";mv "$cutover" "$final.cutover";mv "$signature" "$final.cutover.sig";chmod 440 "$final" "$final.sha256" "$final.cutover" "$final.cutover.sig";echo "cutover finalized; receipt $final"
