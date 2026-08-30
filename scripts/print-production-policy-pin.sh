#!/bin/bash
set -euo pipefail
if (($#!=1))||! [[ $1 =~ ^[0-9A-Fa-f]{40}$ ]];then printf 'usage: %s <full-40-hex-sha1-commit-oid>\n' "$0" >&2;exit 64;fi
[[ ${STEAM_TOP_POLICY_LAUNCHED:-} == 1 ]]||{ printf 'formal rotation requires the externally pinned launcher\n' >&2;exit 65; }
source_commit=$(printf '%s' "$1"|/usr/bin/tr 'A-F' 'a-f')
source_path=$0
while [[ -L $source_path ]];do source_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$source_path")"&&pwd);source_path=$(/usr/bin/readlink "$source_path");[[ $source_path = /* ]]||source_path="$source_dir/$source_path";done
[[ -f $source_path && ! -L $source_path ]]||{ printf 'helper must be a regular non-symlink file\n' >&2;exit 65; }
script_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$source_path")"&&pwd);root=$(CDPATH= cd -P -- "${STEAM_TOP_POLICY_REPOSITORY:?}"&&pwd)
git_env=(/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME=/var/empty XDG_CONFIG_HOME=/var/empty GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null)
self_identity(){ if /usr/bin/stat -f '%d:%i:%z:%m:%c' "$source_path" >/dev/null 2>&1;then /usr/bin/stat -f '%d:%i:%z:%m:%c' "$source_path";else /usr/bin/stat -c '%d:%i:%s:%Y:%Z' "$source_path";fi; }
self_before=$(self_identity)
[[ $("${git_env[@]}" -C "$root" rev-parse --show-object-format) == sha1 ]]||{ printf 'this release supports SHA-1 repositories only\n' >&2;exit 64; }
"${git_env[@]}" -C "$root" cat-file -e "$source_commit^{commit}" 2>/dev/null||{ printf 'reviewed OID is not an available commit\n' >&2;exit 65; }
[[ $("${git_env[@]}" -C "$root" rev-parse "$source_commit^{commit}") == "$source_commit" ]]||exit 65
"${git_env[@]}" -C "$root" show "$source_commit:scripts/print-production-policy-pin.sh" | /usr/bin/cmp -s - "$source_path"||{ printf 'running helper does not match reviewed commit\n' >&2;exit 65; }
[[ $(self_identity) == "$self_before" ]]||{ printf 'running helper changed during verification\n' >&2;exit 65; }

temporary=$(/usr/bin/mktemp -d "/tmp/steam-top-policy-pin.XXXXXX");active_pid=
cleanup(){ /bin/rm -rf -- "$temporary";[[ -z ${STEAM_TOP_POLICY_LAUNCHER_TEMP:-} ]]||/bin/rm -rf -- "$STEAM_TOP_POLICY_LAUNCHER_TEMP"; }
stop_group(){ local number=$1;if [[ -n $active_pid ]];then /bin/kill -TERM -- "-$active_pid" 2>/dev/null||/bin/kill -TERM "$active_pid" 2>/dev/null||true;for _ in {1..60};do /bin/kill -0 -- "-$active_pid" 2>/dev/null||break;/bin/sleep 0.05;done;if /bin/kill -0 -- "-$active_pid" 2>/dev/null;then /bin/kill -KILL -- "-$active_pid" 2>/dev/null||true;fi;wait "$active_pid" 2>/dev/null||true;fi;trap - EXIT;cleanup;exit $((128+number)); }
trap 'code=$?;cleanup;exit "$code"' EXIT;trap 'stop_group 1' HUP;trap 'stop_group 2' INT;trap 'stop_group 15' TERM
/bin/mkdir -p "$temporary/home"
runner="$temporary/group-runner.py"
/bin/cat >"$runner" <<'PY'
import os,sys
if len(sys.argv)<2 or not os.path.isabs(sys.argv[1]): raise SystemExit(64)
os.setsid();os.execve(sys.argv[1],sys.argv[1:],os.environ)
PY
/bin/chmod 0500 "$runner"
run_group(){ /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" PYTHONNOUSERSITE=1 /usr/bin/python3 -I -E -S "$runner" "$@" & active_pid=$!;set +e;wait "$active_pid";local code=$?;set -e;active_pid=;return "$code"; }
safe_git(){ run_group /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/home" TMPDIR="$temporary" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null "$@"; }
capture_git(){ local variable=$1;shift;safe_git "$@" >"$temporary/git-output";local value=;IFS= read -r value <"$temporary/git-output"||true;printf -v "$variable" '%s' "$value"; }

trusted_node=
for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node /opt/hostedtoolcache/node/*/x64/bin/node;do [[ -e $candidate ]]||continue;resolved=$candidate;while [[ -L $resolved ]];do link_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$resolved")"&&pwd);resolved=$(/usr/bin/readlink "$resolved");[[ $resolved = /* ]]||resolved="$link_dir/$resolved";done;[[ -f $resolved && -x $resolved ]]||continue;trusted_node=$resolved;break;done
[[ -n $trusted_node ]]||{ printf 'trusted root-owned Node.js binary unavailable\n' >&2;exit 1; }
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" PYTHONNOUSERSITE=1 /usr/bin/python3 -I -E -S - "$trusted_node" "$temporary/trusted-node" <<'PY'
import os,stat,sys
source,destination=sys.argv[1:]
for parent in [source,*reversed(["/"+"/".join(source.strip("/").split("/")[:i]) for i in range(1,len(source.strip("/").split("/")))])]:
 s=os.stat(parent,follow_symlinks=False)
 if s.st_uid!=0 or s.st_mode&0o022: raise SystemExit("untrusted Node custody")
fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW);before=os.fstat(fd)
if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_uid!=0 or before.st_mode&0o022: raise SystemExit("untrusted Node binary")
out=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o500)
while True:
 data=os.read(fd,1024*1024)
 if not data: break
 view=memoryview(data)
 while view: view=view[os.write(out,view):]
os.fsync(out);os.fchmod(out,0o555);os.fsync(out);after=os.fstat(fd);path=os.stat(source,follow_symlinks=False)
if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or (path.st_dev,path.st_ino)!=(before.st_dev,before.st_ino): raise SystemExit("Node changed during copy")
os.close(out);os.close(fd)
PY
if [[ -x /usr/bin/shasum ]];then source_digest=$(/usr/bin/shasum -a 256 "$trusted_node"|/usr/bin/awk '{print $1}');node_digest=$(/usr/bin/shasum -a 256 "$temporary/trusted-node"|/usr/bin/awk '{print $1}');else source_digest=$(/usr/bin/sha256sum "$trusted_node"|/usr/bin/awk '{print $1}');node_digest=$(/usr/bin/sha256sum "$temporary/trusted-node"|/usr/bin/awk '{print $1}');fi
[[ $source_digest == "$node_digest" ]]||exit 1

safe_git -C "$temporary" init --quiet repository;safe_git -C "$temporary/repository" remote add origin "file://$root";safe_git -c protocol.file.allow=always -C "$temporary/repository" fetch --quiet --depth=1 --no-tags origin "$source_commit"
alternates="$temporary/repository/.git/objects/info/alternates";[[ ! -s $alternates ]]||exit 1
capture_git fetch_head -C "$temporary/repository" rev-parse FETCH_HEAD;[[ $fetch_head == "$source_commit" ]];safe_git -C "$temporary/repository" checkout --detach --quiet FETCH_HEAD;capture_git checkout_head -C "$temporary/repository" rev-parse HEAD;[[ $checkout_head == "$source_commit" ]]
run_group /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/home" TMPDIR="$temporary" "$temporary/trusted-node" "$temporary/repository/scripts/verify-production-policy-bundle.mjs" "$temporary/repository" >"$temporary/digest";IFS= read -r digest <"$temporary/digest"
printf 'Trusted Node.js: %s sha256:%s\nReviewed clean checkout commit: %s\nReviewed bundle SHA-256: %s\n' "$trusted_node" "$node_digest" "$source_commit" "$digest";printf 'After two-person approval, an environment administrator must run:\n';printf 'gh variable set PRODUCTION_POLICY_BUNDLE_SHA256 --env production-release-policy-approval --body %s\n' "$digest"
