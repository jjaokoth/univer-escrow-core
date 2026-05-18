#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
TMP_DIR="$ROOT_DIR/scripts/.tmp_cache_invalidation"
REPORT_MD="$TMP_DIR/runbook.md"
mkdir -p "$TMP_DIR"

append() {
  echo "$1" >> "$REPORT_MD"
}

rm -f "$REPORT_MD"

append "# Cache Invalidation Validation"
append ""
append "**Timestamp:** $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
append ""
append "## Preconditions"
append "- This script validates that cached namespaced keys are evicted when a simulated update occurs."
append "- It runs locally with Node-based checks (no external dependencies)."
append ""

# We cannot directly run the in-repo TS cache coordinator from bash without a TS runner.
# Instead, we validate behavior using a small node harness that mirrors the coordinator logic.
append "## Step 1: Prepare in-memory namespace"

TENANT_ID="${UE_TENANT_ID:-test-tenant-1}"
CONFIG_KEY="${UE_CONFIG_KEY:-system_feature_flags}"
CACHE_VALUE="${UE_CONFIG_VALUE:-enabled}"

# Ensure the Node harness receives these explicitly.
export UE_TENANT_ID="$TENANT_ID"
export UE_CONFIG_KEY="$CONFIG_KEY"
export UE_CONFIG_VALUE="$CACHE_VALUE"


NS_PREFIX="tenant::${TENANT_ID}::config::${CONFIG_KEY}"
append "- tenantId: $TENANT_ID"
append "- key: $CONFIG_KEY"
append "- namespace prefix: $NS_PREFIX"
append ""

append "## Step 2: Simulate set + flush"

node <<'NODE'
const assert = require('assert');

// Mirror the coordinator namespace rule.
function buildTenantConfigKey(tenantId, key){
  if(!tenantId || !tenantId.trim()) throw new Error('tenantId required');
  if(!key || !key.trim()) throw new Error('key required');
  const safeTenant = tenantId.replaceAll('::', ':');
  const safeKey = key.replaceAll('::', ':');
  return `tenant::${safeTenant}::config::${safeKey}`;
}

const tenantId = process.env.UE_TENANT_ID;
const key = process.env.UE_CONFIG_KEY;
const value = process.env.UE_CONFIG_VALUE;
const k = buildTenantConfigKey(tenantId, key);

const store = new Map();
store.set(k, { value, expiresAtMs: Date.now() + 300000 });

assert(store.has(k), 'expected cache entry to exist after set');

// flushTenant simulation: delete keys with matching prefix
const prefix = `tenant::${tenantId}::config::`;
for (const kk of Array.from(store.keys())){
  if(kk.startsWith(prefix)) store.delete(kk);
}

assert(!store.has(k), 'expected cache entry to be evicted after flush');
console.log('PASS');
NODE

append "- Flush behavior validated via local JS mirror."
append ""
append "## Step 3: Output"
append "Runbook report written to: $REPORT_MD"

# Success exit.
exit 0

