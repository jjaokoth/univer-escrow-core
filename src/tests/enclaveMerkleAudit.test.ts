import assert from 'assert';
import fs from 'fs';
import path from 'path';

import { DatabaseService } from '../services/DatabaseService';
import { EnclaveMerkleAccumulator } from '../services/merkle/EnclaveMerkleAccumulator';
import { ZkInclusionVerifier } from '../services/merkle/ZkInclusionVerifier';

function getLedgerStorePath(): string {
  // Must match DatabaseService.storePath => __dirname('../../data/ledger-store.json')
  // Our test file is in src/tests, so __dirname is dist/tests at runtime.
  // dist/tests/.. => dist ; dist/../../data => data.
  return path.join(__dirname, '../../data/ledger-store.json');
}

function resetLedgerStoreSync(): void {
  const ledgerPath = getLedgerStorePath();
  const ledgerDir = path.dirname(ledgerPath);
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify([]), 'utf8');
}

type EscrowStatus = 'LOCKED' | 'RELEASED' | 'FAILED';

async function appendLedgerLeaf(params: {
  transactionId: string;
  escrowRecordLeafHash: string;
  signature: string;
  status: EscrowStatus;
  validAfterMs: number;
  validUntilMs: number;
  timestamp: string;
}): Promise<void> {
  await DatabaseService.saveRecord({
    transactionId: params.transactionId,
    escrowRecordLeafHash: params.escrowRecordLeafHash,
    signature: params.signature,
    status: params.status,
    validAfterMs: params.validAfterMs,
    validUntilMs: params.validUntilMs,
    timestamp: params.timestamp
  } as any);
}

async function run(): Promise<void> {
  resetLedgerStoreSync();

  const baseTs = new Date('2026-01-01T00:00:00.000Z').getTime();

  // Construct a deterministic ledger sequence.
  // NOTE: Escrow leaf hashing ultimately uses escrowRecordLeafHash persisted in DatabaseService.
  const leaves = [
    'leaf_hash_A',
    'leaf_hash_B',
    'leaf_hash_C',
    'leaf_hash_D'
  ];

  const txIds = ['tx_1', 'tx_2', 'tx_3', 'tx_4'];

  for (let i = 0; i < txIds.length; i++) {
    await appendLedgerLeaf({
      transactionId: txIds[i],
      escrowRecordLeafHash: leaves[i],
      signature: `sig_${i}`,
      status: 'LOCKED',
      validAfterMs: baseTs + i * 1000,
      validUntilMs: baseTs + (i + 10) * 1000,
      timestamp: new Date(baseTs + i * 1000).toISOString()
    });
  }

  const acc = new EnclaveMerkleAccumulator();

  const rootHash = await acc.getRootHash();
  assert.ok(rootHash, 'expected rootHash');

  const txToProve = 'tx_2';
  const proofObj = await acc.getInclusionProof(txToProve);

  const receiptOk = ZkInclusionVerifier.verify({
    leafHash: proofObj.leafHash,
    merkleRootHash: proofObj.merkleRootHash,
    proof: {
      siblings: proofObj.proof.siblings,
      leftRight: proofObj.proof.leftRight,
      leafIndex: proofObj.proof.leafIndex,
      leafCount: proofObj.proof.leafCount
    }
  });

  assert.strictEqual(receiptOk.verified, true, 'expected inclusion proof to verify');

  // Fail-closed regression: mutate an historical leaf hash.
  // This should invalidate the recomputed root.
  const ledgerPath = getLedgerStorePath();
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const parsed = JSON.parse(raw) as Array<any>;
  const idx = parsed.findIndex((r) => r.transactionId === txToProve);
  assert.ok(idx >= 0, 'expected mutated tx present');

  parsed[idx].escrowRecordLeafHash = 'leaf_hash_B_MUTATED';
  fs.writeFileSync(ledgerPath, JSON.stringify(parsed, null, 2), 'utf8');

  const accAfter = new EnclaveMerkleAccumulator();
  const rootAfter = await accAfter.getRootHash();
  assert.notStrictEqual(rootAfter, rootHash, 'expected root to change after tamper');

  // Verification using the old proof matrix against the new root must fail.
  const receiptFail = ZkInclusionVerifier.verify({
    leafHash: proofObj.leafHash,
    merkleRootHash: rootAfter,
    proof: {
      siblings: proofObj.proof.siblings,
      leftRight: proofObj.proof.leftRight,
      leafIndex: proofObj.proof.leafIndex,
      leafCount: proofObj.proof.leafCount
    }
  });

  assert.strictEqual(receiptFail.verified, false, 'expected tampered ledger to fail-closed');

  console.log(JSON.stringify({ result: 'PASS', rootHash, rootAfter }));
}

run().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ result: 'FAIL', error: msg }));
  process.exitCode = 1;
});

