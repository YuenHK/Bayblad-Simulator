#!/usr/bin/env bash
set -euo pipefail
source /opt/steam-top-bootstrap/key-custody-guard.sh
/opt/steam-top-bootstrap/verify-bootstrap.sh;[[ $# -eq 1 && $1 =~ ^[a-f0-9]{64}$ ]]||exit 2
config=/etc/steam-top-bootstrap/trust.json;outbox=$(node -e 'const x=require(process.argv[1]);if(!x.hostReceiptOutbox?.startsWith("/"))process.exit(1);process.stdout.write(x.hostReceiptOutbox)' "$config");root="$outbox/receipts/$1";[[ -d $root && ! -L $root && -L $root/current ]]||exit 1;generation=$(realpath "$root/current");[[ $generation == "$root/"* && -d $generation && ! -L $generation ]]||exit 1;receipt="$generation/payload.json";signature="$receipt.sig";[[ -f $receipt && ! -L $receipt && -f $signature && ! -L $signature ]]||exit 1;read -r ru rm < <(stat -c '%u %a' "$root");read -r gu gm < <(stat -c '%u %a' "$generation");read -r pu pm < <(stat -c '%u %a' "$receipt");read -r su sm < <(stat -c '%u %a' "$signature");[[ $ru == 0 && $rm == 700 && $gu == 0 && $gm == 500 && $pu == 0 && $pm == 400 && $su == 0 && $sm == 400 ]]||exit 1
printf 'RECEIPT-BEGIN %s\n' "$1";base64 <"$receipt";printf 'RECEIPT-SIGNATURE\n';base64 <"$signature";printf 'RECEIPT-END %s\n' "$1"
