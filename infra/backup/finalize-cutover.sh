#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 && -f $1 && ! -L $1 && ${CUTOVER_CONFIRM:-} == DATABASE_URL_CUTOVER_SUCCEEDED ]]||{ echo "cutover finalization refused" >&2;exit 1;}
for name in PROMOTE_MAINTENANCE_PGSERVICE PROMOTE_APP_ROLE PROMOTE_CONFIRM_DATABASE;do [[ -n ${!name:-} ]]||exit 1;done
[[ $PROMOTE_APP_ROLE =~ ^[a-z_][a-z0-9_]{0,62}$ && $PROMOTE_CONFIRM_DATABASE =~ ^[a-z_][a-z0-9_]{0,62}$ ]]||exit 1
PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v db="$PROMOTE_CONFIRM_DATABASE" -v role="$PROMOTE_APP_ROLE" -Atc "select format('grant connect on database %I to %I',:'db',:'role')" | PGSERVICE=$PROMOTE_MAINTENANCE_PGSERVICE psql -X -v ON_ERROR_STOP=1
mv "$1" "$1.finalized"
