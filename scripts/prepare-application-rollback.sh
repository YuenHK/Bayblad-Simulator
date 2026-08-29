#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 5 ]]||{ echo "usage: prepare-application-rollback PREVIOUS_ARTIFACT CURRENT_ARTIFACT CURRENT_ENV OUTPUT_ARTIFACT OUTPUT_ENV" >&2;exit 1;}
previous=$1;current=$2;environment=$3;output=$4;output_env=$5
for directory in "$previous" "$current";do [[ $directory == /* && -d $directory && ! -L $directory ]]||exit 1;(cd "$directory"&&sha256sum -c SHA256SUMS);done
[[ $environment == /* && -f $environment && ! -L $environment && $output == /* && $output_env == /* && ! -e $output && ! -e $output_env ]]||exit 1
mkdir -m 700 "$output"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P)
node "$script_dir/create-application-rollback.mjs" "$previous/release-manifest.json" "$current/release-manifest.json" "$environment" "$output/release-manifest.json" "$output_env"
(cd "$output"&&sha256sum release-manifest.json >SHA256SUMS)
echo "application rollback artifact prepared; database image preserved from current release"
