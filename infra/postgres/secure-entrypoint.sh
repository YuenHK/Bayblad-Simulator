#!/bin/sh
set -eu

install -d -m 0700 -o postgres -g postgres /var/lib/postgresql/tls
install -m 0644 -o postgres -g postgres /run/secrets/postgres_tls_cert /var/lib/postgresql/tls/server.crt
install -m 0600 -o postgres -g postgres /run/secrets/postgres_tls_key /var/lib/postgresql/tls/server.key
exec docker-entrypoint.sh "$@"
