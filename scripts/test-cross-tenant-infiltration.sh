#!/usr/bin/env bash
set -euo pipefail

# Uses the same running integration harness logic by calling a lightweight node script.
# The updated integration test should cover cross-tenant reads.

npm run -s compile-universal
node ./dist/tests/integration.test.js

echo "[cross-tenant-infiltration] PASS"

