#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname "$0")/.."&&pwd -P)
digest=$(/usr/bin/env node "$root/scripts/verify-production-policy-bundle.mjs" "$root")
printf 'Reviewed bundle SHA-256: %s\n' "$digest"
printf 'After two-person approval, an environment administrator must run:\n'
printf 'gh variable set PRODUCTION_POLICY_BUNDLE_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
