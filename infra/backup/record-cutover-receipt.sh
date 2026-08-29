#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover receipt refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 2 ]]||die "root and ready/receipt paths required"
ready=$1;receipt=$2;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/../.."&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in CUTOVER_DATABASE_URL PUBLIC_ORIGIN DEPLOYMENT_MANIFEST_SHA256 CUTOVER_NONCE CUTOVER_SIGNING_KEY;do [[ -n ${!name:-} ]]||die "$name required";done
backup_trusted_root_deployment "$root" "$script_dir" "$root/scripts"||die "host trust";backup_private_file "$CUTOVER_SIGNING_KEY"||die "signing key trust"
[[ $ready == /* && $receipt == /* && -f $ready && ! -L $ready && ! -e $receipt && ! -e $receipt.sig ]]||die "unsafe paths";backup_root_file_mode "$ready" 400||die "ready trust"
"$root/scripts/production-smoke.sh" "$PUBLIC_ORIGIN";node "$root/scripts/create-cutover-receipt.mjs" "$ready" "$CUTOVER_DATABASE_URL" "$PUBLIC_ORIGIN" "$DEPLOYMENT_MANIFEST_SHA256" "$CUTOVER_NONCE" "$receipt"
ssh-keygen -Y sign -q -f "$CUTOVER_SIGNING_KEY" -n steam-top-cutover "$receipt";chmod 400 "$receipt" "$receipt.sig"
