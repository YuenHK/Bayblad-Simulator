#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]]||exit 2;source_dir=$(CDPATH= cd -- "$1"&&pwd -P);output=$2;tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT
for name in install-bootstrap.sh verify-package-tree.mjs verify-bootstrap.sh verify-reaper-health.sh advance-first-deploy-state.sh read-first-deploy-state.sh read-install-receipt.sh inspect-first-deploy-chain.mjs key-custody-guard.sh verify-attestation-identity.mjs inspect-generation-chain.mjs prepare-release.sh deploy-release.sh fetch-receipt.sh fetch-deployment-evidence.sh activate-production-state.sh resolve-production-state.sh publish-generation.sh record-cutover-current.sh finalize-current.sh confirm-cutover-current.sh abort-cutover-current.sh reconcile-cutover-pending.sh import-legacy-cutover-current.sh;do [[ -f $source_dir/$name && ! -L $source_dir/$name ]]||exit 1;mode=0444;[[ $name == *.sh ]]&&mode=0555;install -m "$mode" "$source_dir/$name" "$tmp/$name";done
for name in steam-top-cutover-reaper.service steam-top-cutover-reaper.timer;do [[ -f $source_dir/../systemd/$name && ! -L $source_dir/../systemd/$name ]]||exit 1;install -m 0444 "$source_dir/../systemd/$name" "$tmp/$name";done
sha(){ if command -v sha256sum >/dev/null;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;};for name in abort-cutover-current.sh activate-production-state.sh advance-first-deploy-state.sh read-first-deploy-state.sh read-install-receipt.sh inspect-first-deploy-chain.mjs confirm-cutover-current.sh deploy-release.sh fetch-deployment-evidence.sh fetch-receipt.sh finalize-current.sh import-legacy-cutover-current.sh inspect-generation-chain.mjs install-bootstrap.sh key-custody-guard.sh prepare-release.sh publish-generation.sh reconcile-cutover-pending.sh record-cutover-current.sh resolve-production-state.sh steam-top-cutover-reaper.service steam-top-cutover-reaper.timer verify-attestation-identity.mjs verify-bootstrap.sh verify-package-tree.mjs verify-reaper-health.sh;do mode=0444;[[ $name == *.sh ]]&&mode=0555;printf '%s %s %s\n' "$(sha "$tmp/$name")" "$mode" "$name";done >"$tmp/bootstrap-files.sha256"
if tar --help 2>&1|grep -q -- '--sort';then (cd "$tmp"&&tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -- *)|gzip -n >"$output";else python3 - "$tmp" <<'PY'|gzip -n >"$output"
import io,os,sys,tarfile
root=sys.argv[1]
with tarfile.open(fileobj=sys.stdout.buffer,mode="w|") as archive:
  for name in sorted(os.listdir(root)):
    path=os.path.join(root,name);data=open(path,"rb").read();info=tarfile.TarInfo(name);info.size=len(data);info.mode=os.stat(path).st_mode&0o777;info.uid=info.gid=0;info.uname=info.gname="";info.mtime=0;archive.addfile(info,io.BytesIO(data))
PY
fi
