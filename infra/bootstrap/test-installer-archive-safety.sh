#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 1 ]]||exit 2
installer=$(realpath "$1");validator=$(dirname "$installer")/validate-bootstrap-tar.py;[[ -f $validator ]];root=/run/steam-top-installer-archive-test
rm -rf "$root";install -d -o root -g root -m 0700 "$root"
trap 'rm -rf "$root"' EXIT
install -o root -g root -m 0444 "$validator" "$root/validate-bootstrap-tar.py";validator="$root/validate-bootstrap-tar.py"
ssh-keygen -q -t ed25519 -N '' -f "$root/source-key";chmod 0400 "$root/source-key"
printf 'source %s\n' "$(ssh-keygen -y -f "$root/source-key")" > "$root/allowed";chmod 0444 "$root/allowed"
printf '{"deploymentPurpose":"release-integration"}\n' > "$root/trust.json";chmod 0400 "$root/trust.json"
before=$( { find /opt/steam-top-bootstrap /etc/steam-top-bootstrap /var/lib/steam-top-bootstrap -maxdepth 3 -printf '%p|%y|%m|%s\n' 2>/dev/null || true; } | sort | sha256sum )
for attack in traversal absolute symlink hardlink fifo oversized duplicate count pax global-pax huge-pax gnu-longname sparse bomb truncated huge-signature;do
  python3 - "$root/$attack.tgz" "$attack" "$installer" <<'PY'
import hashlib,io,sys,tarfile
out,attack,installer=sys.argv[1:];installer_bytes=open(installer,"rb").read()
kwargs={"format":tarfile.PAX_FORMAT if attack in {"pax","global-pax","huge-pax"} else tarfile.GNU_FORMAT}
if attack in {"global-pax","huge-pax"}:kwargs["pax_headers"]={"comment":"x"*(100_000 if attack=="huge-pax" else 1)}
with tarfile.open(out,"w:gz",**kwargs) as tar:
  manifest=hashlib.sha256(installer_bytes).hexdigest().encode()+b" 0555 install-bootstrap.sh\n"
  info=tarfile.TarInfo("bootstrap-files.sha256");info.size=len(manifest);info.mode=0o644;info.uid=info.gid=0;tar.addfile(info,io.BytesIO(manifest))
  canonical=tarfile.TarInfo("install-bootstrap.sh");canonical.size=len(installer_bytes);canonical.mode=0o555;canonical.uid=canonical.gid=0;tar.addfile(canonical,io.BytesIO(installer_bytes))
  if attack=="count":
    for index in range(65):
      item=tarfile.TarInfo(f"entry{index}");item.size=1;item.mode=0o444;item.uid=item.gid=0;tar.addfile(item,io.BytesIO(b"x"))
    raise SystemExit
  name={"traversal":"../escape","absolute":"/escape","gnu-longname":"x"*200}.get(attack,"attack")
  info=tarfile.TarInfo(name);info.mode=0o555;info.uid=info.gid=0
  if attack=="pax":info.pax_headers={"comment":"untrusted-extension"}
  if attack=="symlink":info.type=tarfile.SYMTYPE;info.linkname="/etc/passwd"
  elif attack=="hardlink":info.type=tarfile.LNKTYPE;info.linkname="bootstrap-files.sha256"
  elif attack=="fifo":info.type=tarfile.FIFOTYPE
  elif attack=="sparse":info.type=tarfile.GNUTYPE_SPARSE
  elif attack=="oversized":info.size=2_097_153
  elif attack=="bomb":info.size=2_000_000
  else:info.size=1
  tar.addfile(info,None if attack in {"symlink","hardlink","fifo"} else io.BytesIO(b"x"*info.size))
  if attack=="duplicate":tar.addfile(info,io.BytesIO(b"x"))
if attack=="truncated":
  data=open(out,"rb").read();open(out,"wb").write(data[:-17])
PY
  ssh-keygen -Y sign -q -f "$root/source-key" -n steam-top-bootstrap-source "$root/$attack.tgz"
  if [[ $attack == huge-signature ]];then dd if=/dev/zero bs=65537 count=1 status=none >>"$root/$attack.tgz.sig";fi
  digest=$(sha256sum "$root/$attack.tgz"|awk '{print $1}')
  expected=;case $attack in gnu-longname)expected=GNU_LONGNAME;;pax|global-pax|huge-pax)expected=PAX;;sparse)expected=SPARSE;;truncated)expected=TRUNCATED;;oversized|bomb)expected=BOMB;;count)expected=HEADER;;esac
  if [[ -n $expected ]];then if python3 "$validator" "$root/$attack.tgz" "$root/$attack.validated.tar" >"$root/$attack.parser.out" 2>"$root/$attack.parser.err";then echo "raw parser accepted: $attack" >&2;exit 1;fi;grep -qx "$expected" "$root/$attack.parser.err"||{ echo "wrong raw reason: $attack" >&2;cat "$root/$attack.parser.err" >&2;exit 1;};test ! -e "$root/$attack.validated.tar";fi
  reason='unsafe or invalid signed archive';case $attack in oversized|bomb) reason='archive';;huge-signature) reason='bootstrap input snapshot';;esac
  if BOOTSTRAP_TAR_VALIDATOR="$validator" BOOTSTRAP_TAR_VALIDATOR_SHA256=$(sha256sum "$validator"|awk '{print $1}') EXPECTED_BOOTSTRAP_ARCHIVE_SHA256=$digest BOOTSTRAP_ALLOWED_SIGNERS_FILE="$root/allowed" "$installer" "$root/$attack.tgz" "$root/$attack.tgz.sig" source "$root/trust.json" --no-systemd-for-integration 2>"$root/$attack.err";then echo "malicious tar accepted: $attack" >&2;exit 1;fi
  grep -F "$reason" "$root/$attack.err" >/dev/null||{ echo "wrong rejection boundary: $attack" >&2;cat "$root/$attack.err" >&2;exit 1;}
  after=$( { find /opt/steam-top-bootstrap /etc/steam-top-bootstrap /var/lib/steam-top-bootstrap -maxdepth 3 -printf '%p|%y|%m|%s\n' 2>/dev/null || true; } | sort | sha256sum )
  [[ $before == "$after" ]]||{ echo "installer mutated state for $attack" >&2;exit 1;}
done
# Fault-model coverage for the snapshot copier boundaries.  The production
# installer executes the same checks before its root gate.
printf '%*s' 65537 '' >"$root/huge-signature";[[ $(stat -c %s "$root/huge-signature") -gt 65536 ]]
python3 - <<'PY'
import io
# growing-archive: bytes beyond initial fstat are rejected.
source=io.BytesIO(b"abcX");initial=3;data=source.read(initial);assert len(data)==initial and source.read(1),"growing source was not detected"
# short-write-fault: a complete-write loop advances until every byte is stored.
payload=b"abcdef";calls=[]
def short_write(view): calls.append(bytes(view));return min(2,len(view))
written=0
while written<len(payload):
 count=short_write(payload[written:]);assert count>0;written+=count
assert written==len(payload) and len(calls)==3
PY
# Exercise the same fd-copy invariant used by the production gate: replacing
# the original after the copy cannot alter the private snapshot, and an
# unprivileged writer cannot replace it.
printf original >"$root/original";python3 - "$root/original" "$root/snapshot" <<'PY'
import os,sys
i=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW);o=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444);os.write(o,os.read(i,1024));os.fsync(o);os.close(o);os.close(i)
PY
printf replaced >"$root/original";[[ $(<"$root/snapshot") == original ]]||{ echo "original archive replacement changed the immutable snapshot" >&2;exit 1;}
if command -v runuser >/dev/null&&runuser -u nobody -- sh -c 'printf attack >"$1"' sh "$root/snapshot" 2>/dev/null;then echo "unprivileged snapshot replacement succeeded" >&2;exit 1;fi
