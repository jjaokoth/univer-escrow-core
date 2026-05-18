#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/securerise/packages/backend"

# The telemetry publisher writes telemetry windows in-memory.
# For a verification harness we execute a small Node script that
# publishes a burst of events and prints a markdown score sheet.

NODE_BIN="node"

TMP_DIR="$ROOT_DIR/.tmp_telemetry_test"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

cat > "$TMP_DIR/telemetry_test_runner.js" <<'JS'
/* eslint-disable no-console */
const { TelemetryPublisherService } = require('../securerise/packages/backend/dist/services/TelemetryPublisherService');

(async () => {
  // If dist is not built, fallback to ts-node/register is not guaranteed.
  // So we require the TS file through ts-node if available.
})();
JS

# Build backend (tsc) if dist artifacts are missing.
if [ ! -d "$BACKEND_DIR/dist" ]; then
  (cd "$BACKEND_DIR" && npm run build) || true
fi

# Prefer direct ts execution when possible.
if [ -f "$BACKEND_DIR/dist/services/TelemetryPublisherService.js" ]; then
  (cd "$ROOT_DIR" && node - <<'NODE'
const path = require('path');
const TelemetryPublisherService = require('./securerise/packages/backend/dist/services/TelemetryPublisherService').TelemetryPublisherService;

const publisher = new TelemetryPublisherService({ maxQueueSize: 10000, batchSize: 500, drainIntervalMs: 1 });
publisher.start();

const TOTAL = 5000;
let notices = 0;
for (let i = 0; i < TOTAL; i++) {
  const classification = i % 20 === 0 ? 'NOTICE' : 'ROUTINE';
  if (classification === 'NOTICE') notices++;
  publisher.publishTelemetryEvent({
    classification,
    eventType: 'runtime_latency',
    payload: {
      method: 'GET',
      path: '/api/v1/test',
      statusCode: 200,
      latencyMicros: 1200,
      latencyMs: 1.2,
    },
    meta: { tenantToken: 'tenant_'+i, authorization: 'Bearer secret_'+i }
  });
}

// Wait for drain.
setTimeout(() => {
  const snap = publisher.getTelemetryClusterWindowSnapshot();
  const routine = snap.ROUTINE.length;
  const notice = snap.NOTICE.length;
  const expectedNotice = notices;
  const expectedRoutine = TOTAL - notices;

  const privacySuspects = (events) => {
    let found = 0;
    for (const e of events) {
      const serialized = JSON.stringify(e);
      if (serialized.includes('tenant_') || serialized.includes('Bearer secret_')) found++;
    }
    return found;
  };

  const routineSuspects = privacySuspects(snap.ROUTINE);
  const noticeSuspects = privacySuspects(snap.NOTICE);

  const okThroughput = (routine + notice) > 0;
  const okCounts = (notice === expectedNotice) && (routine === expectedRoutine);
  const okPrivacy = (routineSuspects === 0 && noticeSuspects === 0);

  const passed = okThroughput && okCounts && okPrivacy;

  const markdown = [];
  markdown.push('# Telemetry Pipeline Verification');
  markdown.push('');
  markdown.push(`- Total Published: ${TOTAL}`);
  markdown.push(`- ROUTINE Count: ${routine} (expected ${expectedRoutine})`);
  markdown.push(`- NOTICE Count: ${notice} (expected ${expectedNotice})`);
  markdown.push(`- Privacy Scrub Suspects: ${routineSuspects + noticeSuspects}`);
  markdown.push('');
  markdown.push(`**Result:** ${passed ? 'PASS' : 'FAIL'}`);

  process.stdout.write(markdown.join('\n') + '\n');

  process.exit(passed ? 0 : 1);
}, 150);
NODE
  )
else
  echo "Telemetry verification could not locate backend dist artifacts. Run npm build in backend first." >&2
  exit 1
fi

