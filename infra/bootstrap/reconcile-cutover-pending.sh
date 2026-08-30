#!/usr/bin/env bash
set -euo pipefail
source /opt/steam-top-bootstrap/key-custody-guard.sh
[[ $(id -u) -eq 0 && $# -eq 0 ]]||exit 2;/opt/steam-top-bootstrap/verify-bootstrap.sh;config=/etc/steam-top-bootstrap/trust.json
mapfile -t values < <(node - "$config" <<'NODE'
const c=require(process.argv[2]);for(const k of ["cutoverPgService","cutoverPgServiceFile","cutoverPgPassFile","cutoverIncidentDir"])if(typeof c[k]!=="string"||!c[k])process.exit(1);console.log(c.cutoverPgService);console.log(c.cutoverPgServiceFile);console.log(c.cutoverPgPassFile);console.log(c.cutoverIncidentDir);console.log(c.deploymentPurpose??"production");
NODE
);service=${values[0]};service_file=${values[1]};pass_file=${values[2]};incident=${values[3]};purpose=${values[4]};lock=/var/lock/steam-top-production.lock;pointer=/opt/steam-top/current;[[ $purpose == release-integration ]]&&{ lock=/var/lock/steam-top-release-integration.lock;pointer=/opt/steam-top/release-integration-current;};[[ -f $lock && ! -L $lock ]]||exit 1;exec 9<>"$lock";flock -n 9||exit 75;runtime=$(realpath "$pointer");[[ $runtime == /opt/steam-top/releases/* && -d $runtime && ! -L $runtime ]]||exit 1;PROMOTE_PGSERVICE="$service" PGSERVICEFILE="$service_file" PGPASSFILE="$pass_file" "$runtime/infra/backup/reconcile-cutover-pending.sh" "$incident"
