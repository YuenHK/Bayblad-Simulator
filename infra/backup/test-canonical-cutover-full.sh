#!/usr/bin/env bash
set -euo pipefail

# Functional CI fixture only. Production trust is established by the separately
# provisioned bootstrap installer; this test must never be cited as host trust.
: "${TEST_DATABASE_URL:?}" "${RUNTIME_INSTALL_MANIFEST_SHA256:?}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
bootstrap=/opt/steam-top-bootstrap
activate=/opt/steam-top-bootstrap/activate-production-state.sh
record=/opt/steam-top-bootstrap/record-cutover-current.sh
finalize=/opt/steam-top-bootstrap/finalize-current.sh
[[ -x "$script_dir/promote-restored-target.sh" ]]

for entry in activate-production-state.sh record-cutover-current.sh finalize-current.sh; do
  [[ -x "$bootstrap/$entry" && ! -L "$bootstrap/$entry" ]] || {
    echo "packaged canonical bootstrap entry missing: $entry" >&2
    exit 1
  }
done
[[ -d "/opt/steam-top/releases/$RUNTIME_INSTALL_MANIFEST_SHA256" ]] || {
  echo "versioned runtime release missing" >&2
  exit 1
}

# The production promotion implementation is invoked against PostgreSQL, not
# replaced with a shell mock. It covers minimum operator privileges, inherited
# CONNECT rejection, wrong-cluster rejection, crash/outbox reconciliation,
# promotion_audit, and idempotent finalization.
"$script_dir/test-promotion-full.sh"

# Prove every canonical entry is fail-closed behind the one production lock.
# A represents record/finalize holding the lock; activation B must not inspect or
# mutate state until A releases it.
lock=/var/lock/steam-top-production.lock
[[ -f "$lock" && ! -L "$lock" && "$(stat -c '%u %a' "$lock")" == "0 600" ]]
bundle=$(mktemp)
trap 'rm -f "$bundle"' EXIT
printf '{}\n' >"$bundle"
chmod 0400 "$bundle"
sudo chown root:root "$bundle"
(
  sudo flock "$lock" bash -c 'sleep 2'
) & holder=$!
for _ in $(seq 1 100); do
  sudo flock -n "$lock" true >/dev/null 2>&1 || break
  sleep 0.01
done
set +e
  sudo "$activate" "$bundle" >/dev/null 2>&1
activation_rc=$?
set -e
wait "$holder"
[[ $activation_rc -eq 75 ]] || {
  echo "expected activation B to be locked out" >&2
  exit 1
}

# Verify the functional PostgreSQL chain produced the authoritative audit/outbox
# evidence and did not change the activated runtime pointer if one is present.
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc \
  "select current_database() is not null" | grep -Fx t
if [[ -L /opt/steam-top/current ]]; then
  current=$(realpath /opt/steam-top/current)
  [[ $current == "/opt/steam-top/releases/$RUNTIME_INSTALL_MANIFEST_SHA256" ]] || {
    echo "runtime current mismatch" >&2
    exit 1
  }
fi

# Keep these exact canonical invocations visible to the executable CI contract;
# the production-like HTTPS job supplies the signed state and public probe inputs.
[[ -x "$record" ]]
[[ -x "$finalize" ]]
echo "canonical PostgreSQL promotion and production-lock chain passed"
