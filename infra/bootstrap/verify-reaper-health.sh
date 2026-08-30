#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover reaper health check refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 0 ]]||die "root only"
/opt/steam-top-bootstrap/verify-bootstrap.sh||die "bootstrap seal"
source /opt/steam-top-bootstrap/key-custody-guard.sh
config=/etc/steam-top-bootstrap/trust.json;key_private_file "$config"||die "trust config custody"
mapfile -t values < <(node - "$config" <<'NODE'
const c=require(process.argv[2]);if(c.deploymentPurpose!=="production")process.exit(1);for(const k of ["cutoverPgService","cutoverPgServiceFile","cutoverPgPassFile","cutoverIncidentDir"]){if(typeof c[k]!=="string"||!c[k]||((k.endsWith("File")||k.endsWith("Dir"))&&!c[k].startsWith("/")))process.exit(1);console.log(c[k])}
NODE
)
[[ ${#values[@]} -eq 4 && ${values[0]} =~ ^[A-Za-z0-9_.-]+$ ]]||die "trust config fields"
key_private_file "${values[1]}"||die "PGSERVICEFILE custody"
key_private_file "${values[2]}"||die "PGPASSFILE custody"
[[ -d ${values[3]} && ! -L ${values[3]} ]]||die "incident directory";read -r owner mode < <(stat -c '%u %a' "${values[3]}");[[ $owner == 0 && $mode == 700 ]]||die "incident directory custody"
/opt/steam-top-bootstrap/reconcile-cutover-pending.sh
systemctl is-enabled --quiet steam-top-cutover-reaper.timer||die "timer disabled";systemctl is-active --quiet steam-top-cutover-reaper.timer||die "timer inactive"
[[ $(systemctl show steam-top-cutover-reaper.service -p Result --value) == success ]]||die "service result";[[ $(systemctl show steam-top-cutover-reaper.service -p ExecMainStatus --value) == 0 ]]||die "service exit"
