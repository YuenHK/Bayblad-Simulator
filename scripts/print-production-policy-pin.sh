#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname "$0")/.."&&pwd -P)
reviewed=${1:-HEAD}
if (($#==0));then printf 'WARNING: no reviewed commit supplied; defaulting to current HEAD. Production rotation must pass the reviewed commit explicitly.\n' >&2;fi
source_commit=$(git -C "$root" rev-parse --verify "$reviewed^{commit}")
temporary=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-policy-pin.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
git clone --no-hardlinks --no-checkout --quiet "$root" "$temporary/repository"
alternates="$temporary/repository/.git/objects/info/alternates"
if [[ -e $alternates && -s $alternates ]];then printf 'independent policy clone unexpectedly uses alternates\n' >&2;exit 1;fi
git -C "$temporary/repository" checkout --detach --quiet "$source_commit"
[[ $(git -C "$temporary/repository" rev-parse HEAD) == "$source_commit" ]]
[[ $(git -C "$root" rev-parse --verify "$reviewed^{commit}") == "$source_commit" ]]
digest=$(/usr/bin/env node "$temporary/repository/scripts/verify-production-policy-bundle.mjs" "$temporary/repository")
commit=$(git -C "$temporary/repository" rev-parse HEAD)
printf 'Reviewed clean checkout commit: %s\n' "$commit"
printf 'Reviewed bundle SHA-256: %s\n' "$digest"
printf 'After two-person approval, an environment administrator must run:\n'
printf 'gh variable set PRODUCTION_POLICY_BUNDLE_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
