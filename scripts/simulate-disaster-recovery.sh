#!/usr/bin/env bash
set -euo pipefail

# Simulate disaster recovery and validate failover behavior.
#
# Requirements:
# - Runs fully inside local dev environment using relative paths.
# - Injects a mock database timeout (via adapter hooks if present).
# - Triggers mock transaction validation requests.
# - Confirms that failover middleware sets degraded mode header.
# - Produces a markdown runbook report.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPORT_DIR="$ROOT_DIR/scripts/.tmp_disaster_recovery_report"
mkdir -p "$REPORT_DIR"
REPORT_MD="$REPORT_DIR/runbook.md"

# Configurable endpoints: host app may provide a local server.
# Default to placeholder; the script is intended as a compliance harness.
API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"

# Helper to emit markdown lines.
append_md() {
  echo "$1" >> "$REPORT_MD"
}

rm -f "$REPORT_MD"

append_md "# Disaster Recovery Simulation Runbook"
append_md ""
append_md "**Timestamp:** $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
append_md ""
append_md "## Environment"
append_md "- Root dir: $ROOT_DIR"
append_md "- API base: $API_BASE_URL"
append_md ""
append_md "## Step 1: Inject mock DB timeout"

# If a host harness supports toggles, it can read this env var.
export UE_MOCK_PRIMARY_DB_TIMEOUT=1
export UE_MOCK_PRIMARY_DB_TIMEOUT_MS=${UE_MOCK_PRIMARY_DB_TIMEOUT_MS:-500}

append_md "- UE_MOCK_PRIMARY_DB_TIMEOUT=${UE_MOCK_PRIMARY_DB_TIMEOUT}"
append_md "- UE_MOCK_PRIMARY_DB_TIMEOUT_MS=${UE_MOCK_PRIMARY_DB_TIMEOUT_MS}"

# Small sleep to let server adapters pick up env changes.
sleep 0.25

append_md ""
append_md "## Step 2: Trigger mock transaction validation"
append_md "- Sending GET to /health and POST to /api/v1/escrows/initiate (if present)"

# Use curl if available.
if ! command -v curl >/dev/null 2>&1; then
  append_md "\n> curl not found: cannot execute live requests. Exiting with compliance failure."
  exit 1
fi

# Capture a health probe
HEALTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE_URL/health" || true)
append_md "- /health HTTP: ${HEALTH_STATUS:-unknown}"

# Attempt an initiation request (host route may differ)
INIT_RESP_HEADERS=$(mktemp)
HTTP_INIT_CODE=$(curl -sS -D "$INIT_RESP_HEADERS" -o /dev/null -w "%{http_code}" \
  -X POST "$API_BASE_URL/api/v1/escrows/initiate" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: global-trust-tenant" \
  --data '{"tenantId":"global-trust-tenant","amount":100,"phoneNumber":"254700000000"}' \
  || true)

# Parse degraded header if present
DEGRADED_MODE=$(grep -i "^x-degraded-mode:" "$INIT_RESP_HEADERS" | tail -n 1 | awk -F':' '{print $2}' | tr -d ' \r\n' || true)
rm -f "$INIT_RESP_HEADERS"

append_md "- /api/v1/escrows/initiate HTTP: ${HTTP_INIT_CODE:-unknown}"
append_md "- X-Degraded-Mode header: ${DEGRADED_MODE:-absent}"

append_md ""
append_md "## Step 3: Validate failover redirect semantics"
if [[ "$DEGRADED_MODE" == "1" || "$DEGRADED_MODE" == "true" ]]; then
  append_md "**Result:** PASS: Failover middleware signaled Degraded Mode to suppress client mutation inputs."
  PASS=1
else
  append_md "**Result:** FAIL: Degraded Mode header missing/incorrect."
  PASS=0
fi

append_md ""
append_md "## Step 4: Output"
append_md "Runbook report written to: $REPORT_MD"

if [[ "$PASS" -ne 1 ]]; then
  exit 1
fi

exit 0

