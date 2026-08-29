#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 && -n ${ADMIN_SMOKE_USERNAME:-} && -n ${ADMIN_SMOKE_PASSWORD:-} ]]||exit 2;origin=$1;host=$(node -e 'const u=new URL(process.argv[1]);if(u.protocol!=="https:"||u.port||u.pathname!=="/")process.exit(1);process.stdout.write(u.hostname)' "$origin");resolve="${host}:443:127.0.0.1";cookies=$(mktemp);trap 'rm -f "$cookies"' EXIT
curl --fail --silent --show-error --resolve "$resolve" "$origin/" >/dev/null
curl --fail --silent --show-error --resolve "$resolve" "$origin/health/ready" >/dev/null
upgrade=$(printf 'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n' "$host"|timeout 10 openssl s_client -quiet -connect 127.0.0.1:443 -servername "$host" 2>/dev/null);[[ ${upgrade%%$'\r\n'*} == *" 101 "* ]]
body=$(node -e 'process.stdout.write(JSON.stringify({username:process.argv[1],password:process.argv[2]}))' "$ADMIN_SMOKE_USERNAME" "$ADMIN_SMOKE_PASSWORD")
curl --fail --silent --show-error --resolve "$resolve" -c "$cookies" -H "Origin: $origin" -H 'Sec-Fetch-Site: same-origin' -H 'Content-Type: application/json' --data "$body" "$origin/api/admin/login" >/dev/null
curl --fail --silent --show-error --resolve "$resolve" -b "$cookies" -H "Origin: $origin" "$origin/api/admin/session" >/dev/null
curl --fail --silent --show-error --resolve "$resolve" -b "$cookies" -H "Origin: $origin" "$origin/api/admin/records?limit=1" >/dev/null
