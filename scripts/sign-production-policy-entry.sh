#!/bin/bash
set -euo pipefail
if (($#!=3));then printf 'usage: %s <offline-private-key> <canonical-entry.json> <signature-output>\n' "$0" >&2;exit 64;fi
for node in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node;do if [[ -x $node && ! -L $node ]];then exec "$node" "$(cd "$(dirname "$0")"&&pwd -P)/sign-production-policy-entry.mjs" "$@";fi;done
printf 'trusted Node runtime unavailable\n' >&2;exit 69
