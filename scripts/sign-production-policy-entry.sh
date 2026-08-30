#!/bin/bash
set -euo pipefail
if (($#!=3));then printf 'usage: %s <offline-private-key> <canonical-entry.json> <signature-output>\n' "$0" >&2;exit 64;fi
[[ -f $1 && -f $2 && ! -e $3 ]]||exit 65
/usr/bin/ssh-keygen -Y sign -n steam-top-production-policy-root -f "$1" <"$2" >"$3"
