import http from 'http';
import fs from 'fs';
import path from 'path';

import { DatabaseService } from '../services/DatabaseService.js';
import { LedgerAuditor } from '../services/LedgerAuditor.js';
import { NotaryAnchorService } from '../services/NotaryAnchorService.js';

const ROOT_DIR = path.join(process.cwd());
const LEDGER_STORE = path.join(ROOT_DIR, 'data/ledger-store.json');
const FROZEN_MARKER = path.join(ROOT_DIR, 'data/ledger-frozen.marker');

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function postJson(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const u = new URL(url);
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (resp) => {
        let buf = '';
        resp.setEncoding('utf8');
        resp.on('data', (c) => (buf += c));
        resp.on('end', () => {
          try {
            const parsed = buf ? JSON.parse(buf) : null;
            resolve({ status: resp.statusCode ?? 0, data: parsed });
          } catch {
            resolve({ status: resp.statusCode ?? 0, data: buf });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  // 1) Ensure ledger + checkpoint exist.
  await DatabaseService.saveRecord({
    transactionId: 'tx_admin_unfreeze_reg_1',
    escrowRecordLeafHash: 'commit_stub_admin_unfreeze_reg_1',
    signature: 'sig',
    status: 'LOCKED',
    timestamp: new Date().toISOString()
  } as any);

  // 2) Start auditor.
  const auditor = LedgerAuditor.getInstance();
  auditor.start({ intervalMs: 1000 });

  // 3) Bootstrap notary authoritative state to current ledger root by forcing a broadcast.
  const records = await DatabaseService.getAllRecords();
  // LedgerAuditor.updateCheckpointNow broadcasts best-effort; if mock notary is running, state will be established.
  // Trigger a checkpoint update.
  const { root, tree } = (await import('../services/merkle/ledgerMerkle.js')).buildMerkleForLedger(records);
  auditor.updateCheckpointNow(root, tree.getLeafCount());

  // Wait for checkpoint / notary sync.
  await sleep(300);

  // 4) Tamper ledger store to trigger freeze.
  const raw = fs.readFileSync(LEDGER_STORE, 'utf8');
  const arr = JSON.parse(raw);
  arr[0] = { ...arr[0], amount: Number(arr[0].amount) + 999 };
  fs.writeFileSync(LEDGER_STORE, JSON.stringify(arr, null, 2), 'utf8');

  // Wait for freeze marker.
  const start = Date.now();
  while (!fs.existsSync(FROZEN_MARKER) && Date.now() - start < 10000) {
    await sleep(100);
  }

  if (!fs.existsSync(FROZEN_MARKER)) {
    throw new Error('Freeze marker not detected; auditor did not freeze as expected');
  }

  // 5) Call unfreeze endpoint.
  // NOTE: This regression requires ADMIN_RECOVERY_OFFICER_PUBLIC_KEYS and threshold signatures to be provided.
  const payload = {
    requestId: `req_${Date.now()}`,
    action: 'LEDGER_UNFREEZE_RITUAL',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    signatures: []
  };

  const resp = await postJson('http://localhost:3000/api/escrow/admin/unfreeze', payload);
  // For now, just assert it is not 200 when signatures missing.
  if (resp.status === 200) {
    throw new Error('Unfreeze unexpectedly succeeded without multi-sig signatures');
  }

  console.log('Admin unfreeze endpoint reachable; regression harness ready for providing signatures.');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

