#!/usr/bin/env bash
set -euo pipefail
die(){ echo "bootstrap installation refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && ( $# -eq 4 || ( $# -eq 5 && $5 =~ ^--(install-systemd|no-systemd-for-integration)$ ) ) ]]||die "root and archive/signature/signer/config [systemd policy] required"
archive=$1;signature=$2;signer=$3;config=$4;systemd_policy=${5:-};: "${EXPECTED_BOOTSTRAP_ARCHIVE_SHA256:?}" "${BOOTSTRAP_ALLOWED_SIGNERS_FILE:?}"
[[ $EXPECTED_BOOTSTRAP_ARCHIVE_SHA256 =~ ^[a-f0-9]{64}$ && -f $archive && ! -L $archive && -f $signature && ! -L $signature && -f $config && ! -L $config ]]||die "inputs"
deployment_purpose=$(node -p 'const x=require(process.argv[1]).deploymentPurpose??"production";if(!["production","release-integration"].includes(x))process.exit(1);x' "$config")||die "deployment purpose";if [[ $deployment_purpose == production ]];then [[ -z $systemd_policy || $systemd_policy == --install-systemd ]]||die "production requires systemd";systemd_policy=--install-systemd;else [[ $systemd_policy == --no-systemd-for-integration ]]||die "integration must explicitly waive systemd";fi
trusted_parents(){ local directory owner mode;directory=$(dirname "$1");while [[ $directory != / ]];do [[ -d $directory && ! -L $directory ]]||return 1;read -r owner mode < <(stat -c '%u %a' "$directory");[[ $owner == 0 && $((8#$mode&022)) -eq 0 ]]||return 1;directory=$(dirname "$directory");done;};read -r ao am < <(stat -c '%u %a' "$BOOTSTRAP_ALLOWED_SIGNERS_FILE");read -r co cm < <(stat -c '%u %a' "$config");[[ $ao == 0 && $am == 444 && $co == 0 && $cm == 400 ]]&&trusted_parents "$BOOTSTRAP_ALLOWED_SIGNERS_FILE"&&trusted_parents "$config"||die "root external trust inputs"
sha(){ if command -v sha256sum >/dev/null;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;};[[ $(sha "$archive") == "$EXPECTED_BOOTSTRAP_ARCHIVE_SHA256" ]]||die "external archive digest"
ssh-keygen -Y verify -q -f "$BOOTSTRAP_ALLOWED_SIGNERS_FILE" -I "$signer" -n steam-top-bootstrap-source -s "$signature" <"$archive"||die "external archive signature"
tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT;tar -xzf "$archive" -C "$tmp" --no-same-owner;[[ -f $tmp/bootstrap-files.sha256 ]]||die "manifest"
install -d -o root -g root -m 0555 /opt/steam-top-bootstrap /etc/steam-top-bootstrap
while IFS=' ' read -r digest mode path extra;do [[ -z ${extra:-} && $path =~ ^[A-Za-z0-9._/-]+$ && $path != *..* ]]||die "manifest grammar";[[ -f $tmp/$path && ! -L $tmp/$path && $(sha "$tmp/$path") == "$digest" ]]||die "package digest";install -D -o root -g root -m "$mode" "$tmp/$path" "/opt/steam-top-bootstrap/$path";done <"$tmp/bootstrap-files.sha256"
install -o root -g root -m 0400 "$tmp/bootstrap-files.sha256" /opt/steam-top-bootstrap/bootstrap-files.sha256;install -o root -g root -m 0400 "$config" /etc/steam-top-bootstrap/trust.json
install -d -o root -g root -m 0700 /var/lib/steam-top-bootstrap;if [[ $deployment_purpose == production && ! -e /opt/steam-top/current && ! -e /var/lib/steam-top-bootstrap/first-deploy.pending ]];then printf 'schemaVersion=1\npurpose=steam-top-first-deploy\n' >/var/lib/steam-top-bootstrap/first-deploy.pending;chown root:root /var/lib/steam-top-bootstrap/first-deploy.pending;chmod 0400 /var/lib/steam-top-bootstrap/first-deploy.pending;fi
for lock in /var/lock/steam-top-generation-publish.lock /var/lock/steam-top-production.lock /var/lock/steam-top-release-integration.lock;do if [[ ! -e $lock ]];then install -o root -g root -m 0600 /dev/null "$lock";else [[ -f $lock && ! -L $lock ]]||die "lock unsafe";chmod 0600 "$lock";chown root:root "$lock";fi;done
/opt/steam-top-bootstrap/verify-bootstrap.sh
if [[ $systemd_policy == --install-systemd ]];then
  [[ $(uname -s) == Linux && -d /run/systemd/system ]]||die "systemd Linux host required"
  node - "$config" <<'NODE'||die "production reaper config"
const c=require(process.argv[2]);for(const k of ["cutoverPgService","cutoverPgServiceFile","cutoverPgPassFile","cutoverIncidentDir"]){if(typeof c[k]!=="string"||!c[k]||((k.endsWith("File")||k.endsWith("Dir"))&&!c[k].startsWith("/")))process.exit(1)}
NODE
  systemd-analyze verify /opt/steam-top-bootstrap/steam-top-cutover-reaper.service /opt/steam-top-bootstrap/steam-top-cutover-reaper.timer||die "systemd units invalid"
  install -o root -g root -m 0644 /opt/steam-top-bootstrap/steam-top-cutover-reaper.service /etc/systemd/system/steam-top-cutover-reaper.service
  install -o root -g root -m 0644 /opt/steam-top-bootstrap/steam-top-cutover-reaper.timer /etc/systemd/system/steam-top-cutover-reaper.timer
  systemd_failed=true;rollback_systemd(){ if [[ $systemd_failed == true ]];then systemctl disable --now steam-top-cutover-reaper.timer >/dev/null 2>&1||true;rm -f /etc/systemd/system/steam-top-cutover-reaper.service /etc/systemd/system/steam-top-cutover-reaper.timer;systemctl daemon-reload >/dev/null 2>&1||true;fi;};trap 'rollback_systemd;rm -rf "$tmp"' EXIT
  systemctl daemon-reload&&systemctl enable --now steam-top-cutover-reaper.timer&&systemctl start steam-top-cutover-reaper.service||die "cutover reaper activation"
  /opt/steam-top-bootstrap/verify-reaper-health.sh||die "cutover reaper health"
  systemd_failed=false
fi
