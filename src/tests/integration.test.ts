import assert from 'assert';
import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const writeFile = fs.promises.writeFile;

type JsonObject = Record<string, unknown>;

type HttpResponse = {
  status: number;
  headers: Headers;
  json: () => Promise<any>;
  text: () => Promise<string>;
};

async function fetchJson(url: string, init: RequestInit): Promise<HttpResponse> {
  // Node16+ has global fetch in modern runtimes, but we guard for older.
  const anyGlobal: any = globalThis as any;
  const f = anyGlobal.fetch as undefined | ((...args: any[]) => Promise<any>);
  if (!f) {
    throw new Error('Global fetch is not available. Use Node 18+ to run this harness.');
  }
  const res = await f(url, init);
  return res as HttpResponse;
}

function getLedgerStorePath(): string {
  // Must match DatabaseService.storePath => __dirname('../../data/ledger-store.json')
  // Our test file is in src/tests, so its compiled location is dist/tests.
  // dist/tests/.. => dist ; dist/../../data => data.
  return path.join(__dirname, '../../data/ledger-store.json');
}

function resetLedgerStoreSync(): void {
  const ledgerPath = getLedgerStorePath();
  const ledgerDir = path.dirname(ledgerPath);
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify([]), 'utf8');
}

async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetchJson(url, { method: 'GET' });
      if (res.status === 200) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become ready at ${url}`);
}

function canonicalString(tenantId: string, account: string, amount: number): string {
  return `${tenantId}:${account}:${amount}`;
}

function rsaSha256HexSignature(data: string, privateKeyPem: string): string {
  const signer = crypto.createSign('sha256');
  signer.update(Buffer.from(data, 'utf8'));
  signer.end();
  const sig = signer.sign(privateKeyPem);
  return sig.toString('hex');
}

function mutateHexButKeepHex(sigHex: string): string {
  // Flip first nibble (deterministically) while keeping hex and even length.
  if (sigHex.length < 2) return sigHex;
  const first = sigHex[0];
  const replacement = first.toLowerCase() === 'a' ? 'b' : 'a';
  return replacement + sigHex.slice(1);
}

function assertExactUnauthorizedProfile(body: any): void {
  assert.deepStrictEqual(body, {
    status: 'FAILED',
    error: 'Invalid Cryptographic Signature Profile'
  });
}

async function run(): Promise<void> {
  // Ensure deterministic ledger state.
  resetLedgerStoreSync();

  const port = 8080;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Start server (dist/server.js)
  const serverEntrypoint = path.join(__dirname, '../server.js');
  assert.ok(fs.existsSync(serverEntrypoint), `Expected server entrypoint at ${serverEntrypoint}`);

  const child = spawn('node', [serverEntrypoint], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const serverStdout: string[] = [];
  const serverStderr: string[] = [];
  child.stdout?.on('data', (d: Buffer) => serverStdout.push(d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => serverStderr.push(d.toString('utf8')));

  try {
    await waitForServer(`${baseUrl}/health`, 10_000);

    const tenantId = 'tenant_A';
    const account = 'account_123';
    const amount = 250;
    const dataToSign = canonicalString(tenantId, account, amount);

    // Generate RSA keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const publicKeyPem = publicKey.toString();
    const privateKeyPem = privateKey.toString();

    // Happy path signature
    const signatureHex = rsaSha256HexSignature(dataToSign, privateKeyPem);
    assert.match(signatureHex, /^[0-9a-fA-F]+$/);
    assert.strictEqual(signatureHex.length % 2, 0);

    const lockPayload: JsonObject = {
      tenantId,
      account,
      amount,
      publicKey: publicKeyPem,
      signature: signatureHex
    };

    const happyRes = await fetchJson(`${baseUrl}/api/escrow/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lockPayload)
    });

    assert.strictEqual(happyRes.status, 201);
    const happyBody = await happyRes.json();
    assert.strictEqual(happyBody?.status, 'SUCCESS');
    assert.ok(happyBody?.receipt?.transactionId, 'expected receipt.transactionId');

    // Confirm persistence in DatabaseService storage.
    const ledgerPath = getLedgerStorePath();
    const ledgerRaw = fs.readFileSync(ledgerPath, 'utf8');
    const ledger = JSON.parse(ledgerRaw) as any[];
    assert.ok(Array.isArray(ledger), 'ledger store must be array');

    const receiptTxId = String(happyBody.receipt.transactionId);
    const found = ledger.find((r) => r.transactionId === receiptTxId);
    assert.ok(found, 'expected record persisted to DatabaseService');
    assert.strictEqual(found.tenantId, tenantId);
    assert.strictEqual(found.account, account);
    assert.strictEqual(found.amount, amount);
    assert.strictEqual(found.status, 'LOCKED');

    // Malicious path: mismatch signature
    const badSignatureHex = mutateHexButKeepHex(signatureHex);
    const maliciousPayload: JsonObject = {
      tenantId,
      account,
      amount,
      publicKey: publicKeyPem,
      signature: badSignatureHex
    };

    const maliciousRes = await fetchJson(`${baseUrl}/api/escrow/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(maliciousPayload)
    });

    assert.strictEqual(maliciousRes.status, 401);
    const maliciousBody = await maliciousRes.json();
    assertExactUnauthorizedProfile(maliciousBody);

    // Fuzzing path: malformed inputs should not crash process.
    const fuzzCases: Array<{ name: string; payload: JsonObject; expect: number[] }> = [
      {
        name: 'non-hex signature',
        payload: { tenantId, account, amount, publicKey: publicKeyPem, signature: 'zz11' },
        expect: [400, 401]
      },
      {
        name: 'empty signature',
        payload: { tenantId, account, amount, publicKey: publicKeyPem, signature: '' },
        expect: [400, 401]
      },
      {
        name: 'empty required fields',
        payload: { tenantId: '', account: '', amount: '', publicKey: publicKeyPem, signature: signatureHex },
        expect: [400, 401]
      },
      {
        name: 'mangled public key PEM',
        payload: {
          tenantId,
          account,
          amount,
          publicKey: publicKeyPem.replace('-----BEGIN PUBLIC KEY-----', '-----BEGIN PUBLIC KEY BAD-----'),
          signature: signatureHex
        },
        expect: [400, 401]
      }
    ];

    for (const tc of fuzzCases) {
      const r = await fetchJson(`${baseUrl}/api/escrow/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tc.payload)
      });
      assert.ok(tc.expect.includes(r.status), `${tc.name}: expected ${tc.expect.join(' or ')} got ${r.status}`);

      // Attempt to parse JSON if possible; router returns json always on expected paths.
      try {
        const b = await r.json();
        // Only require that it is an object; do not hard-assert error strings beyond signature mismatch.
        assert.ok(b && typeof b === 'object');
      } catch {
        const t = await r.text();
        assert.ok(t.length > 0, `${tc.name}: expected response body`);
      }

      // Ensure server is still alive.
      const pingRes = await fetchJson(`${baseUrl}/health`, { method: 'GET' });
      assert.strictEqual(pingRes.status, 200);
    }

    // Final regression sanity: happy path still works after fuzz.
    const againRes = await fetchJson(`${baseUrl}/api/escrow/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lockPayload)
    });
    assert.strictEqual(againRes.status, 201);

    // If we made it here, all assertions passed.
    console.log(JSON.stringify({ result: 'PASS', ts: new Date().toISOString() }));
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ result: 'FAIL', error: msg }));
  process.exitCode = 1;
});

