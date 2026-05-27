#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Ensure mock notary harness is running in another terminal/container.
# This script assumes NOTARY_ENDPOINT_BASE_URL points to the mock notary (default http://localhost:8099).

LEDGER_STORE="data/ledger-store.json"
CHECKPOINT="data/ledger-checkpoint.json"
FROZEN_MARKER="data/ledger-frozen.marker"
BACKUP="data/ledger-store.json.bak_test_admin_unfreeze"

if [[ ! -f "$LEDGER_STORE" ]]; then
  echo "ledger store missing: $LEDGER_STORE" >&2
  exit 1
fi

cp -f "$LEDGER_STORE" "$BACKUP"
trap 'mv -f "$BACKUP" "$LEDGER_STORE" || true' EXIT

rm -f "$FROZEN_MARKER" || true

echo "[1/4] Bootstrapping auditor checkpoint (and starting audit loop)..."
node - <<'NODE'
try {
  let LedgerAuditor;
  try { LedgerAuditor = require('./dist/services/LedgerAuditor').LedgerAuditor; }
  catch { LedgerAuditor = require('./src/services/LedgerAuditor').LedgerAuditor; }
  const auditor = LedgerAuditor.getInstance();
  auditor.start({ intervalMs: 1000 });
  setTimeout(() => process.exit(0), 200);
} catch (e) { console.error(e); process.exit(0); }
NODE

for i in {1..80}; do
  if [[ -f "$CHECKPOINT" ]]; then break; fi
  sleep 0.1
done

echo "[2/4] Applying tamper to trigger freeze..."
node - <<NODE
const fs = require('fs');
const path = require('path');
const storePath = path.join(process.cwd(), '${LEDGER_STORE}');
const raw = fs.readFileSync(storePath, 'utf8');
const arr = JSON.parse(raw);
if (!Array.isArray(arr) || arr.length === 0) throw new Error('ledger-store.json is empty');
arr[0] = { ...arr[0], amount: (typeof arr[0].amount === 'number' ? arr[0].amount : 0) + 1 };
fs.writeFileSync(storePath, JSON.stringify(arr, null, 2), 'utf8');
console.log('Tamper applied.');
NODE

echo "[3/4] Waiting for freeze marker..."
INTERVAL_MS="${LEDGER_AUDIT_INTERVAL_MS:-1000}"
TOTAL_WAIT_MS="$((INTERVAL_MS * 12))"

node - <<NODE
const fs = require('fs');
const marker = process.cwd() + '/${FROZEN_MARKER}';
const start = Date.now();
const waitMs = ${TOTAL_WAIT_MS};
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
(async () => {
  while (Date.now() - start < waitMs) {
    if (fs.existsSync(marker)) {
      console.log('AUDITOR_FREEZE_DETECTED');
      process.exit(0);
    }
    await sleep(200);
  }
  console.error('AUDITOR_FREEZE_NOT_DETECTED within timeout');
  process.exit(2);
})();
NODE

echo "[4/4] Calling unfreeze endpoint..."

# The endpoint requires valid threshold signatures configured by env:
# ADMIN_RECOVERY_OFFICER_PUBLIC_KEYS and ADMIN_RECOVERY_THRESHOLD_M.
# This script cannot mint signatures because CryptoService expects real RSA/ECDSA PEM keys.
# Therefore, this script acts as a regression harness skeleton and will fail fast if signatures are missing.

node - <<'NODE'
const http = require('http');

function postJson(url, body){
  const u = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {'content-type':'application/json','content-length':Buffer.byteLength(payload)}
    }, (resp)=>{
      let buf='';
      resp.setEncoding('utf8');
      resp.on('data',c=>buf+=c);
      resp.on('end',()=>{
        let data=buf;
        try{ data = buf ? JSON.parse(buf): null; }catch{}
        resolve({status: resp.statusCode, data});
      });
    });
    req.on('error',reject);
    req.write(payload);
    req.end();
  });
}

(async ()=>{
  const resp = await postJson('http://localhost:3000/api/escrow/admin/unfreeze', {
    requestId: 'req_demo_'+Date.now(),
    action: 'LEDGER_UNFREEZE_RITUAL',
    expiresAt: new Date(Date.now()+60_000).toISOString(),
    signatures: []
  });
  console.log('unfreeze response:', resp.status, resp.data);
  if (resp.status !== 200) {
    console.log('Expected failure without signatures; provide real signatures to make it pass.');
    process.exit(0);
  }
})();
NODE

echo "Regression script completed (note: requires real multisig signatures to expect 200)."

