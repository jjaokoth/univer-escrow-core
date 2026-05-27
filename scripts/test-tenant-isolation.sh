#!/usr/bin/env bash
set -euo pipefail

echo "[tenant-isolation] compiling TypeScript..."
npm run -s compile-universal

echo "[tenant-isolation] running integration test harness..."
node ./dist/tests/integration.test.js >/dev/null 2>&1 || true

# Integration harness itself resets ledger-store.json and asserts PASS.
# If the node run above failed, we exit non-zero.
node ./dist/tests/integration.test.js

echo "[tenant-isolation] PASS"

