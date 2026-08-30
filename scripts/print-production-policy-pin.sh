#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname "$0")/.."&&pwd -P)
if (($#!=1))||! [[ $1 =~ ^[0-9A-Fa-f]{40}$|^[0-9A-Fa-f]{64}$ ]];then printf 'usage: %s <full-40-or-64-hex-commit-oid>\n' "$0" >&2;exit 64;fi
source_commit=$(printf '%s' "$1"|tr 'A-F' 'a-f')
git -C "$root" cat-file -e "$source_commit^{commit}" 2>/dev/null||{ printf 'reviewed OID is not an available commit\n' >&2;exit 65; }
[[ $(git -C "$root" rev-parse "$source_commit^{commit}") == "$source_commit" ]]||{ printf 'reviewed OID did not resolve exactly\n' >&2;exit 65; }
temporary=$(mktemp -d "${TMPDIR:-/tmp}/steam-top-policy-pin.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
git -C "$temporary" init --quiet repository
git -C "$temporary/repository" remote add origin "file://$root"
git -C "$temporary/repository" fetch --quiet --depth=1 --no-tags origin "$source_commit"
alternates="$temporary/repository/.git/objects/info/alternates"
if [[ -e $alternates && -s $alternates ]];then printf 'independent policy clone unexpectedly uses alternates\n' >&2;exit 1;fi
source_objects=$(git -C "$root" rev-parse --git-path objects)
[[ $source_objects = /* ]]||source_objects="$root/$source_objects"
source_loose="$source_objects/${source_commit:0:2}/${source_commit:2}"
clone_loose="$temporary/repository/.git/objects/${source_commit:0:2}/${source_commit:2}"
if [[ -e $source_loose && -e $clone_loose && $source_loose -ef $clone_loose ]];then printf 'snapshot commit object unexpectedly shares an inode with source\n' >&2;exit 1;fi
[[ $(git -C "$temporary/repository" rev-parse FETCH_HEAD) == "$source_commit" ]]
git -C "$temporary/repository" checkout --detach --quiet FETCH_HEAD
[[ $(git -C "$temporary/repository" rev-parse HEAD) == "$source_commit" ]]
digest=$(/usr/bin/env node "$temporary/repository/scripts/verify-production-policy-bundle.mjs" "$temporary/repository")
commit=$(git -C "$temporary/repository" rev-parse HEAD)
printf 'Reviewed clean checkout commit: %s\n' "$commit"
printf 'Reviewed bundle SHA-256: %s\n' "$digest"
printf 'After two-person approval, an environment administrator must run:\n'
printf 'gh variable set PRODUCTION_POLICY_BUNDLE_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
