#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "[zk-privacy-auditor-regression] Running zkShielding regression..."
node dist/tests/zkShielding.test.js

echo "[zk-privacy-auditor-regression] Checking persisted ledger-store.json has no plaintext sensitive fields..."
LEDGER_FILE="data/ledger-store.json"
if [[ ! -f "${LEDGER_FILE}" ]]; then
  echo "Ledger file not found: ${LEDGER_FILE}" >&2
  exit 1
fi

# Hard fail if any known sensitive keys appear.
# (These exact key names must never be written to persistent disk.)
if grep -nE 'tenantId|account|amount|blindingSalt' "${LEDGER_FILE}" >/dev/null 2>&1; then
  echo "Plaintext sensitive fields found in ${LEDGER_FILE}" >&2
  grep -nE 'tenantId|account|amount|blindingSalt' "${LEDGER_FILE}" || true
  exit 1
fi

echo "[zk-privacy-auditor-regression] OK: ledger-store.json contains only shielded commitment state."


