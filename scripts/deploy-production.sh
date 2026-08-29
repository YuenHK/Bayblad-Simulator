#!/usr/bin/env bash
set -euo pipefail
die(){ echo "production deployment refused: $1" >&2;exit 1;}
[[ $# -eq 2 ]]||die "usage: deploy-production RELEASE_ARTIFACT_DIR ENV_FILE"
release_dir=$1;env_file=$2
[[ $release_dir == /* && $env_file == /* && -d $release_dir && ! -L $release_dir && -f $env_file && ! -L $env_file ]]||die "paths must be absolute safe files/directories"
for file in release-manifest.json SHA256SUMS;do [[ -f $release_dir/$file && ! -L $release_dir/$file ]]||die "release artifact incomplete";done
snapshot=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-deploy.XXXXXX");chmod 700 "$snapshot";trap 'rm -rf "$snapshot"' EXIT;trap 'exit 130' INT TERM
cp -p "$env_file" "$snapshot/production.env";cp -p "$release_dir/SHA256SUMS" "$snapshot/SHA256SUMS"
while read -r digest name extra;do [[ -z ${extra:-} && $digest =~ ^[a-f0-9]{64}$ && $name =~ ^[A-Za-z0-9._-]+$ && -f $release_dir/$name && ! -L $release_dir/$name ]]||die "unsafe checksum entry";cp -p "$release_dir/$name" "$snapshot/$name";done <"$snapshot/SHA256SUMS"
(cd "$snapshot"&&sha256sum -c SHA256SUMS)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/.."&&pwd -P)
node "$script_dir/validate-deployment-env.mjs" "$snapshot/production.env"
node "$script_dir/verify-release-manifest.mjs" "$snapshot/release-manifest.json" "$snapshot/production.env"
docker compose --project-directory "$root" --env-file "$snapshot/production.env" -f "$root/compose.yaml" config --quiet
docker compose --project-directory "$root" --env-file "$snapshot/production.env" -f "$root/compose.yaml" pull
docker compose --project-directory "$root" --env-file "$snapshot/production.env" -f "$root/compose.yaml" up -d --wait
