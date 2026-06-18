/**
 * Grand End-to-End Sandbox Test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import * as path from 'path';
import * as fs2 from 'fs';
import { bootstrap, shutdown, type BootstrapConfig } from '../index.js';
import { getConfidentialErrorPayload } from '../services/security/EnclaveErrors.js';
import { DatabaseService, type EscrowRecord } from '../services/DatabaseService.js';
import { EnclaveMerkleAccumulator } from '../services/merkle/EnclaveMerkleAccumulator.js';
import { EnclaveClientPuzzleEngine } from '../services/security/EnclaveClientPuzzleEngine.js';

const TEST_LEDGER_STORE = path.join(__dirname, '../../data/test-ledger-sandbox.json');
const TEST_CONFIG: Partial<BootstrapConfig> = {
  enclaveIdentity: {
    pcr0: '0000000000000000000000000000000000000000000000000000000000000000000000',
    mrsigner: 'dGVzdC1tc3NpZ25lcj09',
    mrenclave: 'dGVzdC1tcmVuY2xhdmU9'
  },
  cpuMasterSecret: 'test-cpu-secret',
  port: 0,
  antiDosDifficulty: 50,
  bftQuorumThreshold: 3,
  ledgerStorePath: TEST_LEDGER_STORE
};

describe('Production Launch Sandbox', () => {
  beforeEach(async () => {
    if (fs2.existsSync(TEST_LEDGER_STORE)) fs2.unlinkSync(TEST_LEDGER_STORE);
  });

  afterEach(async () => {
    try { await shutdown(); } catch {}
    if (fs2.existsSync(TEST_LEDGER_STORE)) fs2.unlinkSync(TEST_LEDGER_STORE);
  });

  it('completes bootstrap', async () => {
    const b = await bootstrap(TEST_CONFIG);
    expect(b.getState()).toBe('LISTENING');
  });

  it('handles puzzle engine', async () => {
    const engine = EnclaveClientPuzzleEngine.createNewEngine(50);
    const ch = engine.generateChallenge('test-client');
    expect(ch).toBeDefined();
  });

  it('saves records', async () => {
    const rec: EscrowRecord = {
      transactionId: 'tx-test',
      escrowRecordLeafHash: crypto.createHash('sha256').update('test').digest('hex'),
      signature: 'sig',
      status: 'LOCKED',
      validAfterMs: Date.now(),
      validUntilMs: Date.now() + 86400000,
      timestamp: new Date().toISOString()
    };
    await DatabaseService.saveRecord(rec);
    const r = await DatabaseService.getRecord('tx-test');
    expect(r?.transactionId).toBe('tx-test');
  });

  it('gets merkle root', async () => {
    const m = new EnclaveMerkleAccumulator();
    const root = await m.getRootHash();
    expect(root).toBeDefined();
  });

  it('sanitizes errors', async () => {
    const err = new Error('panic at line 1');
    const conf = getConfidentialErrorPayload(err);
    expect(conf?.trackingId).toBeDefined();
  });
});

describe('Fail-Closed Behavior', () => {
  it('fails closed on attestation mismatch', async () => {
    const brokenConfig: Partial<BootstrapConfig> = {
      enclaveIdentity: {
        pcr0: 'invalid-pcr0',
        mrsigner: 'invalid-mrsigner',
        mrenclave: 'invalid-mrenclave'
      }
    };
    await expect(bootstrap(brokenConfig)).rejects.toThrow();
  });

  afterEach(async () => {
    try { await shutdown(); } catch {}
  });
});
