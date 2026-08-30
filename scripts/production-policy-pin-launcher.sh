#!/bin/bash
set -euo pipefail
if (($#!=2))||! [[ $2 =~ ^[a-f0-9]{40}$ ]];then printf 'usage: %s <repository> <full-40-hex-oid>\n' "$0" >&2;exit 64;fi
repository=$1;commit=$2
repository=$(CDPATH= cd -P -- "$repository"&&pwd)
git=(/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME=/var/empty XDG_CONFIG_HOME=/var/empty GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null)
"${git[@]}" -C "$repository" cat-file -e "$commit^{commit}";blob=$("${git[@]}" -C "$repository" rev-parse "$commit:scripts/print-production-policy-pin.sh");[[ $blob =~ ^[a-f0-9]{40}$ ]]
size=$("${git[@]}" -C "$repository" cat-file -s "$blob");[[ $size =~ ^[1-9][0-9]{0,6}$ ]]
temporary=$(/usr/bin/mktemp -d /tmp/steam-top-policy-launcher.XXXXXX);trap '/bin/rm -rf -- "$temporary"' EXIT HUP INT TERM
"${git[@]}" -C "$repository" cat-file blob "$blob" | /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary" PYTHONNOUSERSITE=1 /usr/bin/python3 -I -E -S -c 'import os,sys
path,expected=sys.argv[1],int(sys.argv[2]);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400);data=sys.stdin.buffer.read(expected+1)
if len(data)!=expected: raise SystemExit("helper blob size mismatch")
view=memoryview(data)
while view: view=view[os.write(fd,view):]
os.fsync(fd);os.fchmod(fd,0o555);os.fsync(fd);os.close(fd)' "$temporary/helper.pending" "$size"
/bin/mv "$temporary/helper.pending" "$temporary/helper"
trap - EXIT HUP INT TERM
exec /usr/bin/env STEAM_TOP_POLICY_REPOSITORY="$repository" STEAM_TOP_POLICY_LAUNCHER_TEMP="$temporary" /bin/bash "$temporary/helper" "$commit"
