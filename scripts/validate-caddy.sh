#!/bin/sh
set -eu

if command -v caddy >/dev/null 2>&1; then
  caddy validate --config Caddyfile --adapter caddyfile
  caddy adapt --config Caddyfile --adapter caddyfile --validate >/dev/null
  exit 0
fi

: "${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
: "${CADDY_IMAGE_REPOSITORY:?CADDY_IMAGE_REPOSITORY is required}"
: "${CADDY_IMAGE_DIGEST:?CADDY_IMAGE_DIGEST is required}"
image="${CADDY_IMAGE_REPOSITORY}@${CADDY_IMAGE_DIGEST}"
mount="$(pwd -P)/Caddyfile:/etc/caddy/Caddyfile:ro"
docker run --rm -e PUBLIC_ORIGIN -v "$mount" "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker run --rm -e PUBLIC_ORIGIN -v "$mount" "$image" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --validate >/dev/null
