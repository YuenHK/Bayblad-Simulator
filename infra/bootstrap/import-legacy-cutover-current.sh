#!/usr/bin/env bash
set -euo pipefail
source /opt/steam-top-bootstrap/key-custody-guard.sh
[[ $(id -u) -eq 0 && $# -eq 4 && $1 =~ ^[a-f0-9]{64}$ && $2 =~ ^[a-f0-9]{64}$ ]]||exit 2
activation_nonce=$1;legacy_nonce=$2;receipt=$3;signature=$4;tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT
mapfile -t config < <(node - /etc/steam-top-bootstrap/trust.json <<'NODE'
const c=require(process.argv[2]);for(const k of ["legacyCutoverAllowedSigners","legacyCutoverSignerId","cutoverPgService","cutoverPgServiceFile","cutoverPgPassFile"])if(typeof c[k]!=="string"||!c[k])process.exit(1);console.log(c.deploymentPurpose??"production");console.log(c.legacyCutoverAllowedSigners);console.log(c.legacyCutoverSignerId);console.log(c.cutoverPgService);console.log(c.cutoverPgServiceFile);console.log(c.cutoverPgPassFile);
NODE
);[[ ${config[0]} == production ]]||exit 1;lock=/var/lock/steam-top-production.lock;[[ -f $lock && ! -L $lock ]]||exit 1;read -r owner mode < <(stat -c '%u %a' "$lock");[[ $owner == 0 && $mode == 600 ]]||exit 1;exec 9<>"$lock";flock -n 9||exit 75
/opt/steam-top-bootstrap/resolve-production-state.sh "$activation_nonce" >"$tmp/frame";runtime=$(awk '/^STATE-BEGIN /{print $5;exit}' "$tmp/frame");[[ $runtime == /opt/steam-top/releases/* && -d $runtime && ! -L $runtime ]]||exit 1;"$runtime/scripts/verify-runtime-install.sh" "$runtime"
env CANONICAL_STATE_RESOLVED=true RUNTIME_INSTALL_MANIFEST_SHA256="$(basename "$runtime")" PROMOTE_PGSERVICE="${config[3]}" PGSERVICEFILE="${config[4]}" PGPASSFILE="${config[5]}" "$runtime/infra/backup/import-legacy-cutover.sh" "$legacy_nonce" "$receipt" "$signature" "${config[1]}" "${config[2]}"
/opt/steam-top-bootstrap/resolve-production-state.sh "$activation_nonce" >"$tmp/after";cmp -s "$tmp/frame" "$tmp/after"
