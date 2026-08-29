#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -eq 0 && $# -eq 1 && $1 =~ ^[a-f0-9]{64}$ && -n ${HOST_RECEIPT_OUTBOX_DIR:-} ]]||exit 1;nonce=$1;receipt="$HOST_RECEIPT_OUTBOX_DIR/$nonce.json";signature="$receipt.sig";[[ -f $receipt && ! -L $receipt && -f $signature && ! -L $signature ]]||exit 1
read -r ro rm < <(stat -c '%u %a' "$receipt");read -r so sm < <(stat -c '%u %a' "$signature");[[ $ro == 0 && $rm == 400 && $so == 0 && $sm == 400 ]]||exit 1
printf 'RECEIPT-BEGIN %s\n' "$nonce";base64 <"$receipt";printf 'RECEIPT-SIGNATURE\n';base64 <"$signature";printf 'RECEIPT-END %s\n' "$nonce"
