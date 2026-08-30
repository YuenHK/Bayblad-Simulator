#!/bin/bash
set -euo pipefail
if (($#!=3));then printf 'usage: %s <offline-private-key> <canonical-entry.json> <signature-output>\n' "$0" >&2;exit 64;fi
[[ -f $1 && -f $2 && ! -e $3 ]]||exit 65
[[ ! -L $1 && ! -L $2 && ! -L $(dirname "$3") ]]||exit 65
if stat -f '%u %Lp %l' "$1" >/dev/null 2>&1;then read -r owner mode links < <(stat -f '%u %Lp %l' "$1");else read -r owner mode links < <(stat -c '%u %a %h' "$1");fi
[[ $owner == "$(id -u)" && $mode == 600 && $links == 1 ]]||{ printf 'offline key custody mismatch\n' >&2;exit 65; }
/usr/bin/node -e 'const fs=require("fs"),p=process.argv[1],t=fs.readFileSync(p,"utf8"),x=JSON.parse(t),y={schemaVersion:1,purpose:"production-policy-root-rotation",generation:x.generation,previousReceiptDigest:x.previousReceiptDigest,repositoryId:x.repositoryId,repositoryName:x.repositoryName,policyCommit:x.policyCommit,policyTreeOid:x.policyTreeOid,bundleSha256:x.bundleSha256,createdAt:x.createdAt,signerKeyId:x.signerKeyId};if(t!==JSON.stringify(y)+"\n")process.exit(1)' "$2"||{ printf 'entry is not canonical\n' >&2;exit 65; }
set -C
trap 'rm -f -- "$3"' ERR HUP INT TERM
/usr/bin/ssh-keygen -Y sign -n steam-top-production-policy-root -f "$1" <"$2" >"$3"
chmod 0400 "$3"
trap - ERR HUP INT TERM
