#!/usr/bin/env bash
set -euo pipefail
if (($#!=1))||! [[ $1 =~ ^[0-9A-Fa-f]{40}$ ]];then printf 'usage: %s <full-40-hex-sha1-commit-oid>\n' "$0" >&2;exit 64;fi
source_commit=$(printf '%s' "$1"|/usr/bin/tr 'A-F' 'a-f')
source_path=$0
while [[ -L $source_path ]];do source_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$source_path")"&&pwd);source_path=$(/usr/bin/readlink "$source_path");[[ $source_path = /* ]]||source_path="$source_dir/$source_path";done
script_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$source_path")"&&pwd)
root=$(CDPATH= cd -P -- "$script_dir/.."&&pwd)
temporary=$(/usr/bin/mktemp -d "/tmp/steam-top-policy-pin.XXXXXX")
cleanup(){ /bin/rm -rf -- "$temporary"; }
trap 'code=$?;cleanup;exit "$code"' EXIT
trap 'trap - EXIT;cleanup;exit 129' HUP
trap 'trap - EXIT;cleanup;exit 130' INT
trap 'trap - EXIT;cleanup;exit 143' TERM
/bin/mkdir -p "$temporary/home"
safe_git(){ /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/home" TMPDIR="$temporary" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 /usr/bin/git "$@"; }
[[ $(safe_git -C "$root" rev-parse --show-object-format) == sha1 ]]||{ printf 'this release supports SHA-1 repositories only\n' >&2;exit 64; }
safe_git -C "$root" cat-file -e "$source_commit^{commit}" 2>/dev/null||{ printf 'reviewed OID is not an available commit\n' >&2;exit 65; }
[[ $(safe_git -C "$root" rev-parse "$source_commit^{commit}") == "$source_commit" ]]||{ printf 'reviewed OID did not resolve exactly\n' >&2;exit 65; }
safe_git -C "$temporary" init --quiet repository
safe_git -C "$temporary/repository" remote add origin "file://$root"
safe_git -c protocol.file.allow=always -C "$temporary/repository" fetch --quiet --depth=1 --no-tags origin "$source_commit"
alternates="$temporary/repository/.git/objects/info/alternates"
if [[ -e $alternates && -s $alternates ]];then printf 'independent policy snapshot unexpectedly uses alternates\n' >&2;exit 1;fi
source_objects=$(safe_git -C "$root" rev-parse --git-path objects)
[[ $source_objects = /* ]]||source_objects="$root/$source_objects"
source_loose="$source_objects/${source_commit:0:2}/${source_commit:2}"
clone_loose="$temporary/repository/.git/objects/${source_commit:0:2}/${source_commit:2}"
if [[ -e $source_loose && -e $clone_loose && $source_loose -ef $clone_loose ]];then printf 'snapshot commit object unexpectedly shares an inode with source\n' >&2;exit 1;fi
[[ $(safe_git -C "$temporary/repository" rev-parse FETCH_HEAD) == "$source_commit" ]]
safe_git -C "$temporary/repository" checkout --detach --quiet FETCH_HEAD
[[ $(safe_git -C "$temporary/repository" rev-parse HEAD) == "$source_commit" ]]
digest=$(/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/home" TMPDIR="$temporary" /usr/bin/env node "$temporary/repository/scripts/verify-production-policy-bundle.mjs" "$temporary/repository")
printf 'Reviewed clean checkout commit: %s\n' "$source_commit"
printf 'Reviewed bundle SHA-256: %s\n' "$digest"
printf 'After two-person approval, an environment administrator must run:\n'
printf 'gh variable set PRODUCTION_POLICY_BUNDLE_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
