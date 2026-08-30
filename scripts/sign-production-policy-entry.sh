#!/bin/bash
set -euo pipefail
if (($#!=3));then printf 'usage: %s <offline-private-key> <canonical-entry.json> <signature-output>\n' "$0" >&2;exit 64;fi
root=$(CDPATH= cd -P -- "$(dirname -- "$0")"&&pwd)
exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C PYTHONNOUSERSITE=1 /usr/bin/python3 -I -E -S "$root/sign-production-policy-entry.py" "$@"
