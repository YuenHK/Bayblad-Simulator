#!/usr/bin/env bash
set -euo pipefail
die(){ echo "bootstrap installation refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && ( $# -eq 4 || ( $# -eq 5 && $5 == --install-systemd ) ) ]]||die "root and archive/signature/signer/config [--install-systemd] required"
archive=$1;signature=$2;signer=$3;config=$4;install_systemd=${5:-};: "${EXPECTED_BOOTSTRAP_ARCHIVE_SHA256:?}" "${BOOTSTRAP_ALLOWED_SIGNERS_FILE:?}"
[[ $EXPECTED_BOOTSTRAP_ARCHIVE_SHA256 =~ ^[a-f0-9]{64}$ && -f $archive && ! -L $archive && -f $signature && ! -L $signature && -f $config && ! -L $config ]]||die "inputs"
trusted_parents(){ local directory owner mode;directory=$(dirname "$1");while [[ $directory != / ]];do [[ -d $directory && ! -L $directory ]]||return 1;read -r owner mode < <(stat -c '%u %a' "$directory");[[ $owner == 0 && $((8#$mode&022)) -eq 0 ]]||return 1;directory=$(dirname "$directory");done;};read -r ao am < <(stat -c '%u %a' "$BOOTSTRAP_ALLOWED_SIGNERS_FILE");read -r co cm < <(stat -c '%u %a' "$config");[[ $ao == 0 && $am == 444 && $co == 0 && $cm == 400 ]]&&trusted_parents "$BOOTSTRAP_ALLOWED_SIGNERS_FILE"&&trusted_parents "$config"||die "root external trust inputs"
sha(){ if command -v sha256sum >/dev/null;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;};[[ $(sha "$archive") == "$EXPECTED_BOOTSTRAP_ARCHIVE_SHA256" ]]||die "external archive digest"
ssh-keygen -Y verify -q -f "$BOOTSTRAP_ALLOWED_SIGNERS_FILE" -I "$signer" -n steam-top-bootstrap-source -s "$signature" <"$archive"||die "external archive signature"
tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT;tar -xzf "$archive" -C "$tmp" --no-same-owner;[[ -f $tmp/bootstrap-files.sha256 ]]||die "manifest"
install -d -o root -g root -m 0555 /opt/steam-top-bootstrap /etc/steam-top-bootstrap
while IFS=' ' read -r digest mode path extra;do [[ -z ${extra:-} && $path =~ ^[A-Za-z0-9._/-]+$ && $path != *..* ]]||die "manifest grammar";[[ -f $tmp/$path && ! -L $tmp/$path && $(sha "$tmp/$path") == "$digest" ]]||die "package digest";install -D -o root -g root -m "$mode" "$tmp/$path" "/opt/steam-top-bootstrap/$path";done <"$tmp/bootstrap-files.sha256"
install -o root -g root -m 0400 "$tmp/bootstrap-files.sha256" /opt/steam-top-bootstrap/bootstrap-files.sha256;install -o root -g root -m 0400 "$config" /etc/steam-top-bootstrap/trust.json
for lock in /var/lock/steam-top-generation-publish.lock /var/lock/steam-top-production.lock /var/lock/steam-top-release-integration.lock;do if [[ ! -e $lock ]];then install -o root -g root -m 0600 /dev/null "$lock";else [[ -f $lock && ! -L $lock ]]||die "lock unsafe";chmod 0600 "$lock";chown root:root "$lock";fi;done
/opt/steam-top-bootstrap/verify-bootstrap.sh
if [[ $install_systemd == --install-systemd ]];then
  [[ $(uname -s) == Linux && -d /run/systemd/system ]]||die "systemd Linux host required"
  systemd-analyze verify /opt/steam-top-bootstrap/steam-top-cutover-reaper.service /opt/steam-top-bootstrap/steam-top-cutover-reaper.timer||die "systemd units invalid"
  install -o root -g root -m 0644 /opt/steam-top-bootstrap/steam-top-cutover-reaper.service /etc/systemd/system/steam-top-cutover-reaper.service
  install -o root -g root -m 0644 /opt/steam-top-bootstrap/steam-top-cutover-reaper.timer /etc/systemd/system/steam-top-cutover-reaper.timer
  systemctl daemon-reload&&systemctl enable --now steam-top-cutover-reaper.timer||die "cutover reaper activation"
  systemctl is-enabled --quiet steam-top-cutover-reaper.timer&&systemctl is-active --quiet steam-top-cutover-reaper.timer||die "cutover reaper inactive"
fi
