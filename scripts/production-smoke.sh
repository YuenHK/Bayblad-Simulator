#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 && -n ${ADMIN_SMOKE_SECRET_FILE:-} && -f $ADMIN_SMOKE_SECRET_FILE && ! -L $ADMIN_SMOKE_SECRET_FILE ]]||exit 2
origin=$1;nonce=$2;[[ $nonce =~ ^[a-f0-9]{64}$ ]]||exit 2;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)
if [[ ${SMOKE_INTEGRATION_MODE:-false} == true ]];then
  [[ $origin == https://steam-top.integration.test:18443 ]]||exit 2;host=steam-top.integration.test;tls_port=18443;http_port=18080
else
  host=$(node -e 'const u=new URL(process.argv[1]);if(u.protocol!=="https:"||u.port||u.pathname!=="/")process.exit(1);process.stdout.write(u.hostname)' "$origin");tls_port=443;http_port=80
fi
resolve_tls="${host}:${tls_port}:127.0.0.1";resolve_http="${host}:${http_port}:127.0.0.1";tmp=$(mktemp -d);trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --resolve "$resolve_http" -o /dev/null -D "$tmp/redirect" "http://$host:$http_port/";grep -Eiq '^location: https://' "$tmp/redirect"
curl --fail --silent --show-error --resolve "$resolve_tls" "$origin/" >"$tmp/index";asset=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"),m=s.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/);if(!m)process.exit(1);process.stdout.write(m[1])' "$tmp/index");curl --fail --silent --show-error --resolve "$resolve_tls" "$origin$asset" >/dev/null
curl --fail --silent --show-error --resolve "$resolve_tls" "$origin/health/ready" >/dev/null;node "$script_dir/production-wss-smoke.mjs" "$origin" "$nonce"
node - "$ADMIN_SMOKE_SECRET_FILE" "$tmp/login.json" <<'NODE'
const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(typeof x.username!=="string"||typeof x.password!=="string"||x.password.length<8)process.exit(1);fs.writeFileSync(process.argv[3],JSON.stringify(x),{mode:0o600});
NODE
curl --fail --silent --show-error --resolve "$resolve_tls" -c "$tmp/cookies" -H "Origin: $origin" -H 'Sec-Fetch-Site: same-origin' -H 'Content-Type: application/json' --data-binary @"$tmp/login.json" "$origin/api/admin/login" >/dev/null
curl --fail --silent --show-error --resolve "$resolve_tls" -b "$tmp/cookies" -H "Origin: $origin" "$origin/api/admin/session" >"$tmp/session";csrf=$(node -e 'const x=require(process.argv[1]);if(typeof x.csrfToken!=="string")process.exit(1);process.stdout.write(x.csrfToken)' "$tmp/session")
curl --fail --silent --show-error --resolve "$resolve_tls" -b "$tmp/cookies" -H "Origin: $origin" "$origin/api/admin/deployment-probe/$nonce" >"$tmp/probe";grep -Fq "$nonce" "$tmp/probe"
if [[ -n ${PRODUCTION_SMOKE_PROBE_OUTPUT:-} ]];then [[ $PRODUCTION_SMOKE_PROBE_OUTPUT == /* && ! -e $PRODUCTION_SMOKE_PROBE_OUTPUT ]]||exit 1;cp "$tmp/probe" "$PRODUCTION_SMOKE_PROBE_OUTPUT";chmod 400 "$PRODUCTION_SMOKE_PROBE_OUTPUT";fi
curl --fail --silent --show-error --resolve "$resolve_tls" -b "$tmp/cookies" -H "Origin: $origin" -H 'Sec-Fetch-Site: same-origin' -H "X-CSRF-Token: $csrf" -X POST "$origin/api/admin/logout" >/dev/null
code=$(curl --silent --show-error --resolve "$resolve_tls" -b "$tmp/cookies" -H "Origin: $origin" -o /dev/null -w '%{http_code}' "$origin/api/admin/session");[[ $code == 401 ]]
