#!/usr/bin/env bash
set -euo pipefail
die(){ echo "bootstrap installation refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 4 ]]||die "root and archive/signature/signer/config required"
archive=$1;signature=$2;signer=$3;config=$4;: "${EXPECTED_BOOTSTRAP_ARCHIVE_SHA256:?}" "${BOOTSTRAP_ALLOWED_SIGNERS_FILE:?}"
[[ $EXPECTED_BOOTSTRAP_ARCHIVE_SHA256 =~ ^[a-f0-9]{64}$ && -f $archive && ! -L $archive && -f $signature && ! -L $signature && -f $config && ! -L $config ]]||die "inputs"
sha(){ if command -v sha256sum >/dev/null;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;};[[ $(sha "$archive") == "$EXPECTED_BOOTSTRAP_ARCHIVE_SHA256" ]]||die "external archive digest"
ssh-keygen -Y verify -q -f "$BOOTSTRAP_ALLOWED_SIGNERS_FILE" -I "$signer" -n steam-top-bootstrap-source -s "$signature" <"$archive"||die "external archive signature"
tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT;tar -xzf "$archive" -C "$tmp" --no-same-owner;[[ -f $tmp/bootstrap-files.sha256 ]]||die "manifest"
install -d -o root -g root -m 0555 /opt/steam-top-bootstrap /etc/steam-top-bootstrap
while IFS=' ' read -r digest mode path extra;do [[ -z ${extra:-} && $path =~ ^[A-Za-z0-9._/-]+$ && $path != *..* ]]||die "manifest grammar";[[ -f $tmp/$path && ! -L $tmp/$path && $(sha "$tmp/$path") == "$digest" ]]||die "package digest";install -D -o root -g root -m "$mode" "$tmp/$path" "/opt/steam-top-bootstrap/$path";done <"$tmp/bootstrap-files.sha256"
install -o root -g root -m 0400 "$tmp/bootstrap-files.sha256" /opt/steam-top-bootstrap/bootstrap-files.sha256;install -o root -g root -m 0400 "$config" /etc/steam-top-bootstrap/trust.json
/opt/steam-top-bootstrap/verify-bootstrap.sh
