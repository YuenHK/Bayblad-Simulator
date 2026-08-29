#!/usr/bin/env bash
set -euo pipefail
die(){ echo "rollback preflight refused: $1" >&2;exit 1;}
[[ $# -eq 2 ]]||die "usage: verify-rollback-preflight BACKUP_SET EXTERNAL_LEDGER"
backup_set=$1;external_ledger=$2
[[ -d $backup_set && ! -L $backup_set && -f $backup_set/COMPLETE && $(<"$backup_set/COMPLETE") == complete ]]||die "backup set incomplete or unsafe"
[[ -f $backup_set/manifest && ! -L $backup_set/manifest && -f $external_ledger && ! -L $external_ledger ]]||die "manifest or external ledger unsafe"
expected_lines=$(sed -n 's/^deletion_ledger_lines=//p' "$backup_set/manifest")
expected_sha=$(sed -n 's/^deletion_ledger_sha256=//p' "$backup_set/manifest")
[[ $expected_lines =~ ^[0-9]+$ && $expected_sha =~ ^[a-f0-9]{64}$ ]]||die "backup ledger metadata invalid"
actual_lines=$(wc -l <"$external_ledger"|tr -d ' ')
if command -v sha256sum >/dev/null 2>&1;then actual_sha=$(sha256sum "$external_ledger"|awk '{print $1}');else actual_sha=$(shasum -a 256 "$external_ledger"|awk '{print $1}');fi
[[ $actual_lines == "$expected_lines" && $actual_sha == "$expected_sha" ]]||die "deletion ledger advanced; database rollback forbidden"
echo "rollback ledger preflight verified"
