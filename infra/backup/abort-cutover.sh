#!/usr/bin/env bash
set -euo pipefail
die(){ echo "cutover abort refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 3 && ${CANONICAL_STATE_RESOLVED:-} == true ]]||die "canonical root wrapper required"
ready=$1;preflight=$2;signature=$3;script_dir=$(CDPATH= cd -- "$(dirname -- "$0")"&&pwd -P);source "$script_dir/host-trust-guard.sh"
for name in PROMOTE_PGSERVICE PGSERVICEFILE PGPASSFILE CUTOVER_ALLOWED_SIGNERS_FILE CUTOVER_SIGNER_ID PROMOTE_STATE_DIR;do [[ -n ${!name:-} ]]||die "$name required";done
ssh-keygen -Y verify -q -f "$CUTOVER_ALLOWED_SIGNERS_FILE" -I "$CUTOVER_SIGNER_ID" -n steam-top-cutover-preflight -s "$signature" <"$preflight"||die "preflight signature";values=$(node -p 'const r=require(process.argv[1]);`${r.promotionNonce}|${r.appRole}`' "$ready");IFS='|' read -r nonce role <<EOF
$values
EOF
PGSERVICE=$PROMOTE_PGSERVICE psql -X -v ON_ERROR_STOP=1 -v nonce="$nonce" -v role="$role" <<'SQL'
begin;select pg_advisory_xact_lock(1937002751);select format('revoke connect on database %I from %I',current_database(),:'role') \gexec
select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename=:'role' and pid<>pg_backend_pid();update restore_control.finalize_outbox set state='aborted' where nonce=:'nonce' and state='connect-granted-pending-smoke';commit;
SQL
install -d -o root -g root -m 0700 "$PROMOTE_STATE_DIR";incident="$PROMOTE_STATE_DIR/CUTOVER-ABORTED.$nonce";printf 'nonce=%s\nstate=aborted\naction=investigate public smoke before retry\n' "$nonce" >"$incident";chmod 600 "$incident";exit 70
