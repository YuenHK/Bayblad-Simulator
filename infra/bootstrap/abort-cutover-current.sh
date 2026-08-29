#!/usr/bin/env bash
set -euo pipefail
source /opt/steam-top-bootstrap/key-custody-guard.sh
[[ $(id -u) -eq 0 && $# -eq 4 && $1 =~ ^[a-f0-9]{64}$ ]]||exit 2
nonce=$1;shift;tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT;purpose=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").deploymentPurpose??"production"');lock=/var/lock/steam-top-production.lock;[[ $purpose == release-integration ]]&&lock=/var/lock/steam-top-release-integration.lock;exec 9<>"$lock";flock -n 9||exit 75
/opt/steam-top-bootstrap/resolve-production-state.sh "$nonce" >"$tmp/frame";runtime=$(awk '/^STATE-BEGIN /{print $5;exit}' "$tmp/frame")
awk -v a="$tmp/state.b64" -v b="$tmp/state.sig.b64" -v c="$tmp/activation.b64" -v d="$tmp/activation.sig.b64" '/^STATE-SIGNATURE$/{out=b;next}/^ACTIVATION-RECEIPT$/{out=c;next}/^ACTIVATION-SIGNATURE$/{out=d;next}/^STATE-END /{out="";next}/^STATE-BEGIN /{out=a;next}out!=""{print >out}' "$tmp/frame";for name in state state.sig activation activation.sig;do base64 -d <"$tmp/$name.b64" >"$tmp/$name";chmod 0400 "$tmp/$name";done
env CANONICAL_STATE_RESOLVED=true CANONICAL_DEPLOYMENT_PURPOSE="$purpose" PROTECTED_DEPLOYMENT_STATE_FILE="$tmp/state" PROTECTED_DEPLOYMENT_STATE_SIGNATURE="$tmp/state.sig" ACTIVATION_RECEIPT_FILE="$tmp/activation" ACTIVATION_RECEIPT_SIGNATURE="$tmp/activation.sig" "$runtime/infra/backup/abort-cutover.sh" "$@"
