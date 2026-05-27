#!/usr/bin/env bash
set -euo pipefail

# Mock notary harness expectations:
#   - Run: node scripts/mock-notary-harness.ts
#   - Then: ./scripts/mock-ledger-tamper-and-audit.sh
# The LedgerAuditor will freeze if the local checkpoint root diverges from the notary authoritative root.



# Repository-safe malicious ledger alteration mock.
# 1) Creates a checkpoint if missing.
# 2) Performs an out-of-band mutation (simulates DB administrator tampering).
# 3) Waits for LedgerAuditor to freeze (data/ledger-frozen.marker).
# 4) Restores original ledger-store.json.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LEDGER_STORE="data/ledger-store.json"
CHECKPOINT="data/ledger-checkpoint.json"
FROZEN_MARKER="data/ledger-frozen.marker"
BACKUP="data/ledger-store.json.bak_blackboxai"

if [[ ! -f "$LEDGER_STORE" ]]; then
  echo "ledger store missing: $LEDGER_STORE" >&2
  exit 1
fi

cp -f "$LEDGER_STORE" "$BACKUP"
trap 'mv -f "$BACKUP" "$LEDGER_STORE" || true' EXIT

# Remove old marker
rm -f "$FROZEN_MARKER" || true

# Ensure checkpoint exists by bootstrapping the auditor loop.
# Prefer compiled JS under ./dist, but fall back to ./src if dist isn't present.
node - <<'NODE'
try {
  let LedgerAuditor;
  try {
    LedgerAuditor = require('./dist/services/LedgerAuditor').LedgerAuditor;
  } catch {
    LedgerAuditor = require('./src/services/LedgerAuditor').LedgerAuditor;
  }

  if (!LedgerAuditor) process.exit(0);

  const auditor = LedgerAuditor.getInstance();
  auditor.start({ intervalMs: 1000000 });
  setTimeout(() => process.exit(0), 200);
} catch (e) {
  console.error('LedgerAuditor bootstrap failed:', e?.message ?? e);
  process.exit(0);
}
NODE

# Give the checkpoint writer a moment (auditor is expected to establish it on first run)
for i in {1..80}; do
  if [[ -f "$CHECKPOINT" ]]; then break; fi
  sleep 0.1
done

# Perform tamper: increment amount of first ledger record by +1.
node - <<NODE
const fs = require('fs');
const path = require('path');
const storePath = path.join(process.cwd(), '${LEDGER_STORE}');
const raw = fs.readFileSync(storePath, 'utf8');
const arr = JSON.parse(raw);
if (!Array.isArray(arr) || arr.length === 0) throw new Error('ledger-store.json is empty');
arr[0] = { ...arr[0], amount: (typeof arr[0].amount === 'number' ? arr[0].amount : 0) + 1 };
fs.writeFileSync(storePath, JSON.stringify(arr, null, 2), 'utf8');
console.log('Tamper applied: amount incremented on first record.');
NODE

# Wait for auditor freeze marker.
INTERVAL_MS="${LEDGER_AUDIT_INTERVAL_MS:-5000}"
TOTAL_WAIT_MS="$((INTERVAL_MS * 8))"
echo "Waiting up to ${TOTAL_WAIT_MS}ms for auditor to detect tamper and freeze..."

node - <<NODE
const fs = require('fs');
const marker = process.cwd() + '/${FROZEN_MARKER}';
const start = Date.now();
const waitMs = ${TOTAL_WAIT_MS};
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  while (Date.now() - start < waitMs) {
    if (fs.existsSync(marker)) {
      const content = fs.readFileSync(marker, 'utf8');
      console.log('AUDITOR_FREEZE_DETECTED');
      console.log(content.toString());
      process.exit(0);
    }
    await sleep(250);
  }
  console.error('AUDITOR_FREEZE_NOT_DETECTED within timeout');
  process.exit(2);
})();
NODE
