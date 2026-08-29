#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 && $1 =~ ^[-A-Za-z0-9_.]+/[-A-Za-z0-9_.]+$ && $2 =~ ^v[0-9A-Za-z._-]+$ ]]||exit 2;repo=$1;tag=$2;output=$3;[[ ! -e $output ]]||exit 1
gh api "repos/$repo/git/ref/tags/$tag" --jq '.object' >"$output";for _ in 1 2 3 4;do type=$(tail -1 "$output"|jq -r .type);[[ $type == tag ]]||break;sha=$(tail -1 "$output"|jq -r .sha);[[ $sha =~ ^[a-f0-9]{40}$ ]]||exit 1;gh api "repos/$repo/git/tags/$sha" --jq '.object' >>"$output";done
