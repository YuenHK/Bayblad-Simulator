#!/bin/bash
set -euo pipefail
launcher=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")"&&pwd)/production-policy-pin-launcher.sh
[[ -f $launcher && ! -L $launcher ]]||exit 1
if [[ -x /usr/bin/shasum ]];then digest=$(/usr/bin/shasum -a 256 "$launcher"|/usr/bin/awk '{print $1}');else digest=$(/usr/bin/sha256sum "$launcher"|/usr/bin/awk '{print $1}');fi
printf 'Reviewed launcher SHA-256: %s\n' "$digest"
printf '{"schemaVersion":1,"purpose":"production-policy-launcher-preview","authorized":false,"launcherSha256":"%s"}\n' "$digest"
