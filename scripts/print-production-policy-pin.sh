#!/bin/bash
set -euo pipefail
if (($#!=1))||! [[ $1 =~ ^[0-9A-Fa-f]{40}$ ]];then printf 'usage: %s <full-40-hex-sha1-commit-oid>\n' "$0" >&2;exit 64;fi
source_commit=$(printf '%s' "$1"|/usr/bin/tr 'A-F' 'a-f')
source_path=$0
while [[ -L $source_path ]];do source_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$source_path")"&&pwd);source_path=$(/usr/bin/readlink "$source_path");[[ $source_path = /* ]]||source_path="$source_dir/$source_path";done
script_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$source_path")"&&pwd);root=$(CDPATH= cd -P -- "$script_dir/.."&&pwd)
temporary=$(/usr/bin/mktemp -d "/tmp/steam-top-policy-pin.XXXXXX");active_pid=
cleanup(){ /bin/rm -rf -- "$temporary"; }
stop_group(){ local number=$1;if [[ -n $active_pid ]];then /bin/kill -TERM -- "-$active_pid" 2>/dev/null||/bin/kill -TERM "$active_pid" 2>/dev/null||true;for _ in {1..15};do /bin/kill -0 "$active_pid" 2>/dev/null||break;/bin/sleep 0.05;done;if /bin/kill -0 "$active_pid" 2>/dev/null;then /bin/kill -KILL -- "-$active_pid" 2>/dev/null||/bin/kill -KILL "$active_pid" 2>/dev/null||true;fi;wait "$active_pid" 2>/dev/null||true;fi;trap - EXIT;cleanup;exit $((128+number)); }
trap 'code=$?;cleanup;exit "$code"' EXIT;trap 'stop_group 1' HUP;trap 'stop_group 2' INT;trap 'stop_group 15' TERM
/bin/mkdir -p "$temporary/home"
launcher="$root/scripts/run-command-group.py";[[ -f $launcher && ! -L $launcher && -x $launcher ]]||{ printf 'trusted command-group launcher unavailable\n' >&2;exit 1; }
run_group(){ /usr/bin/python3 "$launcher" -- "$@" & active_pid=$!;set +e;wait "$active_pid";local code=$?;set -e;active_pid=;return "$code"; }
safe_git(){ run_group /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/home" TMPDIR="$temporary" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null "$@"; }
capture_git(){ local variable=$1;shift;safe_git "$@" >"$temporary/git-output";local value=;IFS= read -r value <"$temporary/git-output"||true;printf -v "$variable" '%s' "$value"; }
capture_git object_format -C "$root" rev-parse --show-object-format;[[ $object_format == sha1 ]]||{ printf 'this release supports SHA-1 repositories only\n' >&2;exit 64; }
safe_git -C "$root" cat-file -e "$source_commit^{commit}" 2>/dev/null||{ printf 'reviewed OID is not an available commit\n' >&2;exit 65; }
capture_git resolved_commit -C "$root" rev-parse "$source_commit^{commit}";[[ $resolved_commit == "$source_commit" ]]||exit 65
stat_mode(){ /usr/bin/stat -f '%Lp' "$1" 2>/dev/null||/usr/bin/stat -c '%a' "$1"; };stat_uid(){ /usr/bin/stat -f '%u' "$1" 2>/dev/null||/usr/bin/stat -c '%u' "$1"; }
trusted_node=
for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node /opt/hostedtoolcache/node/*/x64/bin/node;do [[ -e $candidate ]]||continue;resolved=$candidate;while [[ -L $resolved ]];do link_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$resolved")"&&pwd);resolved=$(/usr/bin/readlink "$resolved");[[ $resolved = /* ]]||resolved="$link_dir/$resolved";done;[[ -f $resolved && -x $resolved ]]||continue;mode=$(stat_mode "$resolved")||continue;(( (8#$mode & 0022)==0 ))||continue;owner=$(stat_uid "$resolved")||continue;[[ $owner == 0 || $owner == $UID ]]||continue;parent=$(/usr/bin/dirname -- "$resolved");safe=1;while :;do mode=$(stat_mode "$parent")||{ safe=0;break; };(( (8#$mode & 0022)==0 ))||{ safe=0;break; };[[ $parent == / ]]&&break;parent=$(/usr/bin/dirname -- "$parent");done;((safe))||continue;trusted_node=$resolved;break;done
[[ -n $trusted_node ]]||{ printf 'trusted Node.js binary unavailable\n' >&2;exit 1; };/bin/cp "$trusted_node" "$temporary/trusted-node";/bin/chmod 0555 "$temporary/trusted-node"
if [[ -x /usr/bin/shasum ]];then node_digest=$(/usr/bin/shasum -a 256 "$temporary/trusted-node"|/usr/bin/awk '{print $1}');elif [[ -x /usr/bin/sha256sum ]];then node_digest=$(/usr/bin/sha256sum "$temporary/trusted-node"|/usr/bin/awk '{print $1}');else exit 1;fi
safe_git -C "$temporary" init --quiet repository;safe_git -C "$temporary/repository" remote add origin "file://$root";safe_git -c protocol.file.allow=always -C "$temporary/repository" fetch --quiet --depth=1 --no-tags origin "$source_commit"
alternates="$temporary/repository/.git/objects/info/alternates";[[ ! -s $alternates ]]||exit 1
capture_git fetch_head -C "$temporary/repository" rev-parse FETCH_HEAD;[[ $fetch_head == "$source_commit" ]];safe_git -C "$temporary/repository" checkout --detach --quiet FETCH_HEAD;capture_git checkout_head -C "$temporary/repository" rev-parse HEAD;[[ $checkout_head == "$source_commit" ]]
run_group /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/home" TMPDIR="$temporary" "$temporary/trusted-node" "$temporary/repository/scripts/verify-production-policy-bundle.mjs" "$temporary/repository" >"$temporary/digest";IFS= read -r digest <"$temporary/digest"
printf 'Trusted Node.js: %s sha256:%s\n' "$trusted_node" "$node_digest";printf 'Reviewed clean checkout commit: %s\nReviewed bundle SHA-256: %s\n' "$source_commit" "$digest";printf 'After two-person approval, an environment administrator must run:\n';printf 'gh variable set PRODUCTION_POLICY_BUNDLE_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
