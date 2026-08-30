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
marker=/var/lib/steam-top-bootstrap/first-deploy.pending;marker_sig=$marker.sig;tombstone=/var/lib/steam-top-bootstrap/first-deploy.consumed
verify_marker(){ [[ ! -e $tombstone && -f $marker && ! -L $marker && -f $marker_sig && ! -L $marker_sig && $(stat -c '%u %a' "$marker") == '0 400' && $(stat -c '%u %a' "$marker_sig") == '0 400' ]]||return 1;local signer host_id host_sha;host_id=$(cat /etc/machine-id 2>/dev/null||hostname);host_sha=$(printf %s "$host_id"|openssl dgst -sha256|awk '{print $NF}');signer=$(node -p 'const x=require(process.argv[1]),host=process.argv[2];if(x.schemaVersion!==1||x.purpose!=="steam-top-first-deploy"||!(/^[a-f0-9]{64}$/.test(x.nonce))||!(/^[a-f0-9]{64}$/.test(x.installDigest))||x.hostIdSha256!==host||!(/^[A-Za-z0-9@._-]+$/.test(x.signerKeyId)))process.exit(1);x.signerKeyId' "$marker" "$host_sha")&&ssh-keygen -Y verify -q -f "${values[5]}" -I "$signer" -n steam-top-first-deploy -s "$marker_sig" <"$marker";}
if [[ ! -e /opt/steam-top/current ]];then
  [[ ! -e ${values[4]}/current ]]&&verify_marker||die "active runtime or sealed first-deploy marker required"
  if [[ $mode == --require-active-runtime ]];then die "active runtime required";fi
  if [[ $mode == --post-migration-first-deploy ]];then
    export PGSERVICEFILE=${values[1]} PGPASSFILE=${values[2]};unset PGPASSWORD PGOPTIONS PGHOST PGPORT PGUSER PGDATABASE
    read -r table_exists pending_count < <(psql "service=${values[0]}" -v ON_ERROR_STOP=1 -qAt -F ' ' -c "SELECT (to_regclass('restore_control.finalize_outbox') IS NOT NULL)::int, CASE WHEN to_regclass('restore_control.finalize_outbox') IS NULL THEN -1 ELSE (SELECT count(*) FROM restore_control.finalize_outbox WHERE state IN ('connect-granted-pending-smoke','smoke-observed')) END")
    [[ $table_exists == 1 && $pending_count == 0 ]]||die "post-migration cutover state is not safe"
    echo post-migration-first-deploy-safe
  else echo not-applicable-clean-host;fi
else
  /opt/steam-top-bootstrap/reconcile-cutover-pending.sh
  if [[ -e $marker || -e $marker_sig ]];then verify_marker||die "first deploy marker invalid";marker_nonce=$(node -p 'require(process.argv[1]).nonce' "$marker");/opt/steam-top-bootstrap/advance-first-deploy-state.sh consumed "$marker_nonce";mv "$marker" "$tombstone";mv "$marker_sig" "$tombstone.sig";PGSERVICE=${values[0]} PGSERVICEFILE=${values[1]} PGPASSFILE=${values[2]} psql -X -v ON_ERROR_STOP=1 -q -v nonce="$marker_nonce" -c "update restore_control.platform_installation set generation=generation+1 where singleton and authorization_nonce=:'nonce'" >/dev/null;fi
fi
systemctl is-enabled --quiet steam-top-cutover-reaper.timer||die "timer disabled";systemctl is-active --quiet steam-top-cutover-reaper.timer||die "timer inactive"
[[ $(systemctl show steam-top-cutover-reaper.service -p Result --value) == success ]]||die "service result";[[ $(systemctl show steam-top-cutover-reaper.service -p ExecMainStatus --value) == 0 ]]||die "service exit"
