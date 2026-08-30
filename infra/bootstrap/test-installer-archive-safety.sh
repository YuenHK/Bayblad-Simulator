#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 1 ]]||exit 2
installer=$(realpath "$1");validator=$(dirname "$installer")/validate-bootstrap-tar.py;[[ -f $validator ]];root=/run/steam-top-installer-archive-test
rm -rf "$root";install -d -o root -g root -m 0700 "$root"
trap 'rm -rf "$root"' EXIT
ssh-keygen -q -t ed25519 -N '' -f "$root/source-key";chmod 0400 "$root/source-key"
printf 'source %s\n' "$(ssh-keygen -y -f "$root/source-key")" > "$root/allowed";chmod 0444 "$root/allowed"
printf '{"deploymentPurpose":"release-integration"}\n' > "$root/trust.json";chmod 0400 "$root/trust.json"
before=$( { find /opt/steam-top-bootstrap /etc/steam-top-bootstrap /var/lib/steam-top-bootstrap -maxdepth 3 -printf '%p|%y|%m|%s\n' 2>/dev/null || true; } | sort | sha256sum )
for attack in traversal absolute symlink hardlink fifo oversized duplicate count pax global-pax huge-pax gnu-longname sparse bomb truncated;do
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
  digest=$(sha256sum "$root/$attack.tgz"|awk '{print $1}')
  expected=;case $attack in gnu-longname)expected=GNU_LONGNAME;;pax|global-pax|huge-pax)expected=PAX;;sparse)expected=SPARSE;;truncated)expected=TRUNCATED;;oversized|bomb)expected=BOMB;;count)expected=HEADER;;esac
  if [[ -n $expected ]];then if python3 "$validator" "$root/$attack.tgz" >"$root/$attack.parser.out" 2>"$root/$attack.parser.err";then echo "raw parser accepted: $attack" >&2;exit 1;fi;grep -qx "$expected" "$root/$attack.parser.err"||{ echo "wrong raw reason: $attack" >&2;cat "$root/$attack.parser.err" >&2;exit 1;};fi
  reason='unsafe or invalid signed archive';case $attack in oversized|bomb) reason='archive';;esac
  if EXPECTED_BOOTSTRAP_ARCHIVE_SHA256=$digest BOOTSTRAP_ALLOWED_SIGNERS_FILE="$root/allowed" "$installer" "$root/$attack.tgz" "$root/$attack.tgz.sig" source "$root/trust.json" --no-systemd-for-integration 2>"$root/$attack.err";then echo "malicious tar accepted: $attack" >&2;exit 1;fi
  grep -F "$reason" "$root/$attack.err" >/dev/null||{ echo "wrong rejection boundary: $attack" >&2;cat "$root/$attack.err" >&2;exit 1;}
  after=$( { find /opt/steam-top-bootstrap /etc/steam-top-bootstrap /var/lib/steam-top-bootstrap -maxdepth 3 -printf '%p|%y|%m|%s\n' 2>/dev/null || true; } | sort | sha256sum )
  [[ $before == "$after" ]]||{ echo "installer mutated state for $attack" >&2;exit 1;}
done
