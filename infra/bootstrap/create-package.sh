#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]]||exit 2;source_dir=$(CDPATH= cd -- "$1"&&pwd -P);output=$2;tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT
for name in verify-bootstrap.sh verify-attestation-identity.mjs prepare-release.sh deploy-release.sh fetch-receipt.sh activate-production-state.sh;do [[ -f $source_dir/$name && ! -L $source_dir/$name ]]||exit 1;mode=0444;[[ $name == *.sh ]]&&mode=0555;install -m "$mode" "$source_dir/$name" "$tmp/$name";done
sha(){ if command -v sha256sum >/dev/null;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;};for name in activate-production-state.sh deploy-release.sh fetch-receipt.sh prepare-release.sh verify-attestation-identity.mjs verify-bootstrap.sh;do mode=0444;[[ $name == *.sh ]]&&mode=0555;printf '%s %s %s\n' "$(sha "$tmp/$name")" "$mode" "$name";done >"$tmp/bootstrap-files.sha256";tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$tmp" -cf - .|gzip -n >"$output"
