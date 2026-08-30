#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname "$0")/.."&&pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-policy-pin.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
git clone --no-local --quiet "$root" "$temporary/repository"
digest=$(/usr/bin/env node "$temporary/repository/scripts/verify-production-policy-bundle.mjs" "$temporary/repository")
commit=$(git -C "$temporary/repository" rev-parse HEAD)
printf 'Reviewed clean checkout commit: %s\n' "$commit"
printf 'Reviewed bundle SHA-256: %s\n' "$digest"
printf 'After two-person approval, an environment administrator must run:\n'
printf 'gh variable set PRODUCTION_POLICY_BUNDLE_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
