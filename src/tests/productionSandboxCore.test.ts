/**
 * Core Sanity Test - No Network Required
 */
import crypto from 'crypto';
import * as path from 'path';
import * as fs2 from 'fs';
import { getConfidentialErrorPayload } from '../services/security/EnclaveErrors.js';
import { DatabaseService, type EscrowRecord } from '../services/DatabaseService.js';
import { EnclaveMerkleAccumulator } from '../services/merkle/EnclaveMerkleAccumulator.js';
import { EnclaveClientPuzzleEngine } from '../services/security/EnclaveClientPuzzleEngine.js';

const TEST_LEDGER_STORE = path.join(__dirname, '../../data/test-ledger-sandbox.json');

async function runCoreTests() {
  console.log("\n🏁 Starting Core Sanity Tests...\n");
  
  if (fs2.existsSync(TEST_LEDGER_STORE)) fs2.unlinkSync(TEST_LEDGER_STORE);
  
  // Test 1: Database operations
  console.log("➡️ Test 1: Database operations...");
  const rec: EscrowRecord = {
    transactionId: 'tx-test-001',
    escrowRecordLeafHash: crypto.createHash('sha256').update('test').digest('hex'),
    signature: 'sig',
    status: 'LOCKED',
    validAfterMs: Date.now(),
    validUntilMs: Date.now() + 86400000,
    timestamp: new Date().toISOString()
  };
  await DatabaseService.saveRecord(rec);
  const r = await DatabaseService.getRecord('tx-test-001');
  if (r?.transactionId !== 'tx-test-001') throw new Error("Database save/get failed");
  console.log("   ✅ Database save/retrieve: PASSED\n");
  
  // Test 2: Merkle accumulator
  console.log("➡️ Test 2: Merkle root hash...");
  const m = new EnclaveMerkleAccumulator();
  const root = await m.getRootHash();
  if (!root || root.length < 10) throw new Error("Merkle root failed");
  console.log(`   Merkle root: ${root.substring(0, 16)}... PASSED\n`);
  
  // Test 3: Puzzle engine
  console.log("➡️ Test 3: Anti-DOS Puzzle engine...");
  const engine = EnclaveClientPuzzleEngine.createNewEngine(50);
  const ch = engine.generateChallenge('test-client');
  if (!ch || !ch.challengeHash) throw new Error("Puzzle challenge failed");
  console.log("   Puzzle challenge generation: PASSED\n");
  
  // Test 4: Error sanitization
  console.log("➡️ Test 4: Error sanitization...");
  const err = new Error('panic at line 1: secret_key=abc123');
  const conf = getConfidentialErrorPayload(err);
  if (!conf || !conf.trackingId) throw new Error("Error sanitization failed");
  console.log(`   Tracking ID: ${conf.trackingId.substring(0, 8)}... PASSED\n`);
  
  // Cleanup
  if (fs2.existsSync(TEST_LEDGER_STORE)) fs2.unlinkSync(TEST_LEDGER_STORE);
  
  console.log("=========================================================================");
  console.log("🎉 ALL CORE TESTS PASSED!");
  console.log("=========================================================================");
}

runCoreTests().catch(e => {
  console.error("❌ TEST FAILURE:", e.message);
  process.exit(1);
});
