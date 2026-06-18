import assert from 'assert';
import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

type HttpResponse = {
  status: number;
  headers: Headers;
  json: () => Promise<any>;
  text: () => Promise<string>;
};

async function fetchJson(url: string, init: RequestInit): Promise<HttpResponse> {
  const anyGlobal: any = globalThis as any;
  const f = anyGlobal.fetch as undefined | ((...args: any[]) => Promise<any>);
  if (!f) {
    throw new Error('Global fetch is not available. Use Node 18+ to run this harness.');
  }
  const res = await f(url, init);
  return res as HttpResponse;
}

function getLedgerStorePath(): string {
  return path.join(__dirname, '../../data/ledger-store.json');
}

function resetLedgerStoreSync(): void {
  const ledgerPath = getLedgerStorePath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify([]), 'utf8');
}

async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetchJson(url, { method: 'GET' });
      if (res.status === 200) {
        return;
      }
    } catch {
      // still waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  return signer.sign(privateKeyPem).toString('hex');
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function solvePuzzleChallenge(challenge: {
  challengeHash: string;
  difficultyMask: string;
}): string {
  const targetMask = Number(challenge.difficultyMask);
  if (!Number.isFinite(targetMask)) {
    throw new Error('Invalid difficulty mask received from challenge');
  }

  for (let nonceIndex = 0; nonceIndex < 500_000; nonceIndex += 1) {
    const candidate = String(nonceIndex);
    const digest = sha256Hex(`${challenge.challengeHash}${candidate}`);
    const leadingValue = Number(`0x${digest.slice(0, 8)}`);
    if ((leadingValue & targetMask) === 0) {
      return candidate;
    }
  }

  throw new Error('Unable to solve puzzle within search budget');
}

async function sendLockRequest(
  url: string,
  payload: Record<string, unknown>,
  solutionHeader?: string
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (solutionHeader) {
    headers['x-puzzle-solution'] = solutionHeader;
  }
  const res = await fetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  return res;
}

async function sendConsensusAppendEntry(
  url: string,
  payload: Record<string, unknown>,
  solutionHeader?: string
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-client-id': 'bft-node-01'
  };
  if (solutionHeader) {
    headers['x-puzzle-solution'] = solutionHeader;
  }
  const res = await fetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  return res;
}

async function run(): Promise<void> {
  resetLedgerStoreSync();

  const port = 8102;
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEntrypoint = path.join(__dirname, '../server.js');

  assert.ok(fs.existsSync(serverEntrypoint), `Expected compiled server entrypoint at ${serverEntrypoint}`);

  const child = spawn('node', [serverEntrypoint], {
    env: {
      ...process.env,
      PORT: String(port),
        ENCLAVE_READY_FOR_TEST: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));

  try {
    await waitForServer(`${baseUrl}/health`);

    const tenantId = 'tenant-dos';
    const account = 'account-dos';
    const amount = 123;
    const dataToSign = canonicalString(tenantId, account, amount);

    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const signatureHex = rsaSha256HexSignature(dataToSign, privateKey.toString());
    assert.match(signatureHex, /^[0-9a-fA-F]+$/);

    const lockPayload = {
      tenantId,
      account,
      amount,
      publicKey: publicKey.toString(),
      signature: signatureHex,
      validAfterMs: Date.now(),
      validUntilMs: Date.now() + 60_000
    };

    const firstRequest = await sendLockRequest(`${baseUrl}/api/escrow/lock`, lockPayload);
    assert.strictEqual(firstRequest.status, 201);
    const secondRequest = await sendLockRequest(`${baseUrl}/api/escrow/lock`, lockPayload);
    assert.strictEqual(secondRequest.status, 201);
    const thirdRequest = await sendLockRequest(`${baseUrl}/api/escrow/lock`, lockPayload);
    assert.strictEqual(thirdRequest.status, 201);

    const challengeRequest = await sendLockRequest(`${baseUrl}/api/escrow/lock`, lockPayload);
    assert.strictEqual(challengeRequest.status, 429);
    const challengeBody = await challengeRequest.json();
    assert.strictEqual(challengeBody.status, 'RATE_LIMITED');
    assert.strictEqual(challengeBody.error, 'PUZZLE_REQUIRED');
    assert.ok(challengeBody.challenge, 'Expected challenge object on 429 response');

    const challenge = challengeBody.challenge as {
      clientId: string;
      serverSeed: string;
      timestampMs: number;
      expiresAtMs: number;
      difficultyMask: string;
      challengeHash: string;
    };

    assert.strictEqual(challenge.clientId, tenantId);
    assert.strictEqual(typeof challenge.serverSeed, 'string');
    assert.strictEqual(typeof challenge.challengeHash, 'string');
    assert.strictEqual(typeof challenge.timestampMs, 'number');
    assert.strictEqual(typeof challenge.expiresAtMs, 'number');
    assert.strictEqual(typeof challenge.difficultyMask, 'string');

    const invalidSolutionHeader = JSON.stringify({
      ...challenge,
      nonce: 'badnonce'
    });

    const invalidResponse = await sendLockRequest(
      `${baseUrl}/api/escrow/lock`,
      lockPayload,
      invalidSolutionHeader
    );
    assert.strictEqual(invalidResponse.status, 429);

    const solvedNonce = solvePuzzleChallenge(challenge);
    const solvedHeader = JSON.stringify({
      ...challenge,
      nonce: solvedNonce
    });

    const validatedResponse = await sendLockRequest(
      `${baseUrl}/api/escrow/lock`,
      lockPayload,
      solvedHeader
    );
    assert.strictEqual(validatedResponse.status, 201);
    const validatedBody = await validatedResponse.json();
    assert.strictEqual(validatedBody.status, 'SUCCESS');
    assert.ok(validatedBody.receipt?.transactionId);

    const consensusPayload = {
      term: 0,
      leaderId: 'leader-node',
      entry: {
        transactionId: 'tx_bft_001',
        escrowRecordLeafHash: 'PENDING',
        signature: 'consensus-sample-signature',
        status: 'LOCKED',
        validAfterMs: Date.now(),
        validUntilMs: Date.now() + 60_000,
        timestamp: new Date().toISOString()
      },
      bft: {
        clusterSize: 4,
        payload: {
          clusterSize: 4,
          f: 1,
          threshold: 3,
          uniqueNodeIds: ['node-a', 'node-b', 'node-c'],
          shares: [
            {
              nodeId: 'node-a',
              nodePcr0Hash: 'abc',
              consensusTerm: 0,
              index: 1,
              approvalHash: 'hash-1',
              nodeSignature: 'sig-1'
            },
            {
              nodeId: 'node-b',
              nodePcr0Hash: 'abc',
              consensusTerm: 0,
              index: 1,
              approvalHash: 'hash-2',
              nodeSignature: 'sig-2'
            },
            {
              nodeId: 'node-c',
              nodePcr0Hash: 'abc',
              consensusTerm: 0,
              index: 1,
              approvalHash: 'hash-3',
              nodeSignature: 'sig-3'
            }
          ]
        }
      }
    };

    const consensusChallengeResponse = await sendConsensusAppendEntry(
      `${baseUrl}/api/consensus/append-entry`,
      consensusPayload
    );

    assert.strictEqual(consensusChallengeResponse.status, 429);
    const consensusChallengeBody = await consensusChallengeResponse.json();
    assert.strictEqual(consensusChallengeBody.status, 'RATE_LIMITED');
    assert.strictEqual(consensusChallengeBody.error, 'PUZZLE_REQUIRED');

    const consensusChallenge = consensusChallengeBody.challenge as {
      challengeHash: string;
      difficultyMask: string;
      clientId: string;
    };

    const consensusNonce = solvePuzzleChallenge(consensusChallenge);
    const consensusHeader = JSON.stringify({
      ...consensusChallenge,
      nonce: consensusNonce
    });

    const consensusValidResponse = await sendConsensusAppendEntry(
      `${baseUrl}/api/consensus/append-entry`,
      consensusPayload,
      consensusHeader
    );

    assert.strictEqual(consensusValidResponse.status, 200);
    const consensusValidBody = await consensusValidResponse.json();
    assert.strictEqual(consensusValidBody.status, 'SUCCESS');
    assert.strictEqual(consensusValidBody.commitIndex, 1);

    console.log(JSON.stringify({ result: 'PASS', ts: new Date().toISOString() }));
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ result: 'FAIL', error: message }));
  process.exitCode = 1;
});
