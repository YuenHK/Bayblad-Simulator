#!/usr/bin/env bash
set -euo pipefail
die(){ echo "production deployment refused: $1" >&2;exit 1;}
[[ $# -eq 5 ]]||die "usage: deploy-production RELEASE_ARTIFACT_DIR ENV_FILE EXPECTED_MANIFEST_SHA256 EXPECTED_REPOSITORY EXPECTED_COMMIT"
release_dir=$1;env_file=$2;expected_manifest_sha=$3;expected_repository=$4;expected_commit=$5
[[ $release_dir == /* && $env_file == /* && -d $release_dir && ! -L $release_dir && -f $env_file && ! -L $env_file ]]||die "paths must be absolute safe files/directories"
[[ $expected_manifest_sha =~ ^[a-f0-9]{64}$ && $expected_repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $expected_commit =~ ^[a-f0-9]{40}$ ]]||die "external authorization inputs invalid"
stat_pair(){ if stat -c '%u %a' "$1" >/dev/null 2>&1;then stat -c '%u %a' "$1";else stat -f '%u %Lp' "$1";fi;}
read -r env_owner env_mode < <(stat_pair "$env_file");[[ $env_owner == 0 && $env_mode == 600 ]]||die "production env must be root-owned 0600"
parent=${env_file%/*};while :;do read -r owner mode < <(stat_pair "$parent");[[ $owner == 0 && $((8#$mode&022)) -eq 0 ]]||die "production env parent writable/untrusted";[[ $parent == / ]]&&break;parent=${parent%/*};[[ -n $parent ]]||parent=/;done
for file in release-manifest.json SHA256SUMS;do [[ -f $release_dir/$file && ! -L $release_dir/$file ]]||die "release artifact incomplete";done
snapshot=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-deploy.XXXXXX");chmod 700 "$snapshot";trap 'rm -rf "$snapshot"' EXIT;trap 'exit 130' INT TERM
cp -p "$env_file" "$snapshot/production.env";cp -p "$release_dir/SHA256SUMS" "$snapshot/SHA256SUMS"
while read -r digest name extra;do [[ -z ${extra:-} && $digest =~ ^[a-f0-9]{64}$ && $name =~ ^[A-Za-z0-9._-]+$ && -f $release_dir/$name && ! -L $release_dir/$name ]]||die "unsafe checksum entry";cp -p "$release_dir/$name" "$snapshot/$name";done <"$snapshot/SHA256SUMS"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/.."&&pwd -P)
case ${DEPLOYMENT_AUTHORIZATION_PURPOSE:-production} in
  production) compose=(docker compose --project-directory "$root" --env-file "$snapshot/canonical.env" -f "$root/compose.yaml" -f "$root/compose.canonical-app.yaml");;
  release-integration) compose=(docker compose -p steam-top-release-integration --project-directory "$root" --env-file "$snapshot/canonical.env" -f "$root/compose.yaml" -f "$root/compose.release-integration.yaml");;
  *) die "deployment purpose invalid";;
esac
"$script_dir/portable-sha256.sh" check "$snapshot" "$snapshot/SHA256SUMS"
[[ $("$script_dir/portable-sha256.sh" digest "$snapshot/release-manifest.json") == "$expected_manifest_sha" ]]||die "external manifest digest mismatch"
node "$script_dir/authorize-production-deploy.mjs" "$snapshot/release-manifest.json" "$snapshot/production.env" "$snapshot/canonical.env" "$expected_repository" "$expected_commit"
"${compose[@]}" config --quiet
"${compose[@]}" pull
if [[ ${DEPLOYMENT_AUTHORIZATION_PURPOSE:-production} == production ]];then
  state_output=$(/opt/steam-top-bootstrap/read-first-deploy-state.sh)||die "signed first-deploy authority missing or corrupt";read -r claim_phase claim_nonce claim_host claim_digest claim_receipt <<<"$state_output";[[ $claim_phase =~ ^(pending|db-claimed|consumed)$ ]]||die "unexpected first-deploy phase"
fi
if [[ ${DEPLOYMENT_AUTHORIZATION_PURPOSE:-production} == production && $claim_phase =~ ^(pending|db-claimed)$ ]];then
  "${compose[@]}" up -d --wait db
  "${compose[@]}" run --rm migration
  [[ -n ${DEPLOYMENT_NONCE:-} && $claim_nonce == "$DEPLOYMENT_NONCE" ]]||die "first-deploy authorization nonce mismatch"
  PGSERVICE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgService' ) PGSERVICEFILE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgServiceFile') PGPASSFILE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgPassFile') "$script_dir/claim-first-installation.sh" "$claim_host" "$claim_digest" "$claim_nonce"
  /opt/steam-top-bootstrap/advance-first-deploy-state.sh db-claimed "$claim_nonce"
  /opt/steam-top-bootstrap/verify-reaper-health.sh --post-migration-first-deploy
fi
if [[ ${DEPLOYMENT_AUTHORIZATION_PURPOSE:-production} == production && $claim_phase == consumed ]];then
  PGSERVICE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgService') PGSERVICEFILE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgServiceFile') PGPASSFILE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgPassFile') psql -X -qAt -v host="$claim_host" -v digest="$claim_digest" -v nonce="$claim_nonce" -c "select case when count(*)=1 then 1 else 1/0 end from restore_control.platform_installation where host_id=:'host' and bootstrap_digest=:'digest' and authorization_nonce=:'nonce' and generation>=2" >/dev/null||die "established database authority mismatch"
fi
if [[ ${DEPLOYMENT_AUTHORIZATION_PURPOSE:-production} == production ]];then
  app_password=$(sed -n 's/^APP_DATABASE_PASSWORD=//p' "$snapshot/canonical.env");[[ -n $app_password ]]||die "app database password missing"
  PGSERVICE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgService') PGSERVICEFILE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgServiceFile') PGPASSFILE=$(node -p 'require("/etc/steam-top-bootstrap/trust.json").cutoverPgPassFile') psql -X -v ON_ERROR_STOP=1 -q -v app_password="$app_password" -f "$root/scripts/provision-app-role.sql" >/dev/null
  unset app_password
fi
"${compose[@]}" up -d --wait
