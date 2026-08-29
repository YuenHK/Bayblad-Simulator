#!/usr/bin/env bash
set -euo pipefail
sha_file(){ if command -v sha256sum >/dev/null 2>&1;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;}
case ${1:-} in
  digest) [[ $# -eq 2 ]]||exit 2;sha_file "$2";;
  manifest) [[ $# -ge 3 ]]||exit 2;directory=$2;shift 2;for name in "$@";do [[ $name =~ ^[A-Za-z0-9._-]+$ && -f $directory/$name && ! -L $directory/$name ]]||exit 1;printf '%s  %s\n' "$(sha_file "$directory/$name")" "$name";done;;
  check) [[ $# -eq 3 ]]||exit 2;directory=$2;list=$3;while read -r expected name extra;do [[ -z ${extra:-} && $expected =~ ^[a-f0-9]{64}$ && $name =~ ^[A-Za-z0-9._-]+$ && -f $directory/$name && ! -L $directory/$name && $(sha_file "$directory/$name") == "$expected" ]]||exit 1;done <"$list";;
  *) exit 2;;
esac
