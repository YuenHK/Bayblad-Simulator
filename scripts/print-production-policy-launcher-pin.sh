#!/bin/bash
set -euo pipefail
launcher=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")"&&pwd)/production-policy-pin-launcher.sh
[[ -f $launcher && ! -L $launcher ]]||exit 1
if [[ -x /usr/bin/shasum ]];then digest=$(/usr/bin/shasum -a 256 "$launcher"|/usr/bin/awk '{print $1}');else digest=$(/usr/bin/sha256sum "$launcher"|/usr/bin/awk '{print $1}');fi
printf 'Reviewed launcher SHA-256: %s\n' "$digest"
printf 'After two-person approval, an environment administrator must run:\n'
printf 'gh variable set PRODUCTION_POLICY_LAUNCHER_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
