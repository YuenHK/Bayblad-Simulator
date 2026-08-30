#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover reaper health check refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && ( $# -eq 0 || ( $# -eq 1 && $1 =~ ^--(require-active-runtime|post-migration-first-deploy)$ ) ) ]]||die "root only [--require-active-runtime|--post-migration-first-deploy]"
mode=${1:-default}
/opt/steam-top-bootstrap/verify-bootstrap.sh||die "bootstrap seal"
source /opt/steam-top-bootstrap/key-custody-guard.sh
config=/etc/steam-top-bootstrap/trust.json;key_private_file "$config"||die "trust config custody"
mapfile -t values < <(node - "$config" <<'NODE'
const c=require(process.argv[2]);if(c.deploymentPurpose!=="production")process.exit(1);for(const k of ["cutoverPgService","cutoverPgServiceFile","cutoverPgPassFile","cutoverIncidentDir","productionStateDir","productionStateAllowedSigners"]){if(typeof c[k]!=="string"||!c[k]||((k.endsWith("File")||k.endsWith("Dir")||k.endsWith("Signers"))&&!c[k].startsWith("/")))process.exit(1);console.log(c[k])}
NODE
)
[[ ${#values[@]} -eq 6 && ${values[0]} =~ ^[A-Za-z0-9_.-]+$ ]]||die "trust config fields"
key_private_file "${values[1]}"||die "PGSERVICEFILE custody"
key_private_file "${values[2]}"||die "PGPASSFILE custody"
[[ -d ${values[3]} && ! -L ${values[3]} ]]||die "incident directory";read -r owner mode < <(stat -c '%u %a' "${values[3]}");[[ $owner == 0 && $mode == 700 ]]||die "incident directory custody"
read -r first_phase first_nonce first_host first_digest first_receipt < <(/opt/steam-top-bootstrap/read-first-deploy-state.sh)||die "signed first-deploy generation required"
if [[ ! -e /opt/steam-top/current ]];then
  [[ ! -e ${values[4]}/current && $first_phase =~ ^(pending|db-claimed)$ ]]||die "active runtime or pending first-deploy generation required"
  if [[ $mode == --require-active-runtime ]];then die "active runtime required";fi
  if [[ $mode == --post-migration-first-deploy ]];then
    export PGSERVICEFILE=${values[1]} PGPASSFILE=${values[2]};unset PGPASSWORD PGOPTIONS PGHOST PGPORT PGUSER PGDATABASE
    read -r table_exists pending_count < <(psql "service=${values[0]}" -v ON_ERROR_STOP=1 -qAt -F ' ' -c "SELECT (to_regclass('restore_control.finalize_outbox') IS NOT NULL)::int, CASE WHEN to_regclass('restore_control.finalize_outbox') IS NULL THEN -1 ELSE (SELECT count(*) FROM restore_control.finalize_outbox WHERE state IN ('connect-granted-pending-smoke','smoke-observed')) END")
    claim=$(psql "service=${values[0]}" -qAt -v nonce="$first_nonce" -v host="$first_host" -v digest="$first_digest" -c "select count(*) from restore_control.platform_installation where authorization_nonce=:'nonce' and host_id=:'host' and bootstrap_digest=:'digest'");[[ $first_phase == db-claimed && $table_exists == 1 && $pending_count == 0 && $claim == 1 ]]||die "post-migration installation claim is not safe"
    echo post-migration-first-deploy-safe
  else echo not-applicable-clean-host;fi
else
  /opt/steam-top-bootstrap/reconcile-cutover-pending.sh
  if [[ $first_phase == db-claimed ]];then changed=$(PGSERVICE=${values[0]} PGSERVICEFILE=${values[1]} PGPASSFILE=${values[2]} psql -X -v ON_ERROR_STOP=1 -qAt -v nonce="$first_nonce" -v host="$first_host" -v digest="$first_digest" -c "update restore_control.platform_installation set generation=2 where singleton and authorization_nonce=:'nonce' and host_id=:'host' and bootstrap_digest=:'digest' and generation=1 returning 1");if [[ -z $changed ]];then current_generation=$(PGSERVICE=${values[0]} PGSERVICEFILE=${values[1]} PGPASSFILE=${values[2]} psql -X -qAt -v nonce="$first_nonce" -v host="$first_host" -v digest="$first_digest" -c "select generation from restore_control.platform_installation where singleton and authorization_nonce=:'nonce' and host_id=:'host' and bootstrap_digest=:'digest'");[[ $current_generation == 2 ]]||die "database installation consume CAS failed";else [[ $changed == 1 ]]||die "database installation consume CAS returned an unexpected row count";fi;/opt/steam-top-bootstrap/advance-first-deploy-state.sh consumed "$first_nonce";first_phase=consumed;fi
  if [[ $first_phase == consumed ]];then authority=$(PGSERVICE=${values[0]} PGSERVICEFILE=${values[1]} PGPASSFILE=${values[2]} psql -X -qAt -v nonce="$first_nonce" -v host="$first_host" -v digest="$first_digest" -c "select count(*) from restore_control.platform_installation where authorization_nonce=:'nonce' and host_id=:'host' and bootstrap_digest=:'digest' and generation=2");[[ $authority == 1 ]]||die "consumed installation authority mismatch";fi
fi
systemctl is-enabled --quiet steam-top-cutover-reaper.timer||die "timer disabled";systemctl is-active --quiet steam-top-cutover-reaper.timer||die "timer inactive"
[[ $(systemctl show steam-top-cutover-reaper.service -p Result --value) == success ]]||die "service result";[[ $(systemctl show steam-top-cutover-reaper.service -p ExecMainStatus --value) == 0 ]]||die "service exit"
