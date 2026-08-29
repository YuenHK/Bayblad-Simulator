#!/bin/sh
set -eu

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--migrate-only" ]; }; then
  echo "usage: migrate-and-start.sh [--migrate-only]" >&2
  exit 64
fi

node migrate-entry.mjs

if [ "${1:-}" = "--migrate-only" ]; then
  exit 0
fi

exec node production-entry.mjs
