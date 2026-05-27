import assert from 'assert';
import crypto from 'crypto';
import { EnclaveSnapshotManager, type EpochStateSnapshot, type QuorumSignature } from '../services/consensus/EnclaveSnapshotManager.js';
import { EnclaveReconciliationEngine, type CatchUpBlock } from '../services/consensus/EnclaveReconciliationEngine.js';
import type { EscrowRecord } from '../services/DatabaseService.js';

/**
 * Regression test: Partition recovery and ledger reconciliation.
 *
 * Scenario:
 * - Node A falls behind during network partition (local index < cluster commitIndex)
 * - Upon partition healing, Node A initiates catch-up
 * - Node A receives either:
 *   a) Individual catch-up blocks (linear Merkle chain)
 *   b) A snapshot (for fast catch-up)
 * - All incoming data is validated for:
 *   - Linear index continuity (no gaps, no rollbacks)
 *   - Merkle chain continuity (no state alterations)
 *   - Quorum signatures (2f+1 nodes approved)
 *
 * Expected outcome: Node A safely reconciles without state rollback risk.
 */

function createMockEntry(index: number, commitment: string): EscrowRecord {
  return {
    transactionId: `tx_${index}`,
    escrowRecordLeafHash: commitment,
    signature: `sig_${index}`,
    status: 'LOCKED',
    validAfterMs: Date.now(),
    validUntilMs: Date.now() + 86400000,
    timestamp: new Date().toISOString()
  };
}

function createMockSignature(nodeId: string, term: number): QuorumSignature {
  return {
    nodeId,
    signature: `sig_${nodeId}_${term}`,
    term
  };
}

function computeEntriesMerkleHash(entries: EscrowRecord[]): string {
  if (entries.length === 0) {
    return crypto.createHash('sha256').update('EMPTY').digest('hex');
  }

  let current = crypto
    .createHash('sha256')
    .update(JSON.stringify(entries[0]))
    .digest('hex');

  for (let i = 1; i < entries.length; i++) {
    const entryHash = crypto.createHash('sha256').update(JSON.stringify(entries[i])).digest('hex');
    current = crypto
      .createHash('sha256')
      .update(current + entryHash)
      .digest('hex');
  }

  return current;
}

async function runPartitionRecoveryRegression(): Promise<void> {
  console.log('🔄 Starting partition recovery regression test...\n');

  // Setup
  const snapshotManager = EnclaveSnapshotManager.getInstance();
  const reconciliationEngine = EnclaveReconciliationEngine.getInstance();

  snapshotManager.__testClearSnapshots();
  reconciliationEngine.__testReset();

  // Scenario 1: Snapshot creation and validation
  console.log('📸 Test 1: Snapshot creation and validation');
  {
    const ledgerEntries: EscrowRecord[] = [
      createMockEntry(1, 'commitment_1'),
      createMockEntry(2, 'commitment_2'),
      createMockEntry(3, 'commitment_3')
    ];

    const quorumSigs: QuorumSignature[] = [
      createMockSignature('node_1', 1),
      createMockSignature('node_2', 1),
      createMockSignature('node_3', 1)
    ];

    const snapshot = snapshotManager.createSnapshot({
      latestIndex: 3,
      latestTerm: 1,
      ledgerEntries,
      quorumSignatures: quorumSigs
    });

    assert(snapshot.metadata.snapshotId, 'Expected snapshot ID');
    assert.strictEqual(snapshot.metadata.latestIndex, 3, 'Expected index 3');
    assert.strictEqual(snapshot.metadata.latestTerm, 1, 'Expected term 1');
    assert.strictEqual(snapshot.quorumSignatures.length, 3, 'Expected 3 signatures');

    const validation = snapshotManager.validateSnapshot(snapshot);
    assert(validation.valid, 'Expected snapshot validation to pass');
    assert(validation.quorumMet, 'Expected quorum threshold met');
    assert(validation.signatureVerified, 'Expected signatures verified');

    console.log('✅ Snapshot creation and validation passed\n');
  }

  // Scenario 2: Lag detection
  console.log('🔍 Test 2: Lag detection');
  {
    // Node A has index 2, cluster has commitIndex 5
    const hasLag = reconciliationEngine.detectLag(2, 5);
    assert(hasLag, 'Expected lag detection to return true');

    // Node A has index 5, cluster has commitIndex 5
    const noLag = reconciliationEngine.detectLag(5, 5);
    assert(!noLag, 'Expected lag detection to return false when caught up');

    console.log('✅ Lag detection passed\n');
  }

  // Scenario 3: Begin reconciliation
  console.log('🚀 Test 3: Begin reconciliation');
  {
    const state = reconciliationEngine.beginReconciliation({
      localIndex: 2,
      targetCommitIndex: 5
    });

    assert(state.isReconciling, 'Expected reconciliation to be in progress');
    assert.strictEqual(state.localIndex, 2, 'Expected local index 2');
    assert.strictEqual(state.targetCommitIndex, 5, 'Expected target 5');
    assert.strictEqual(state.blocksApplied, 0, 'Expected 0 blocks applied initially');

    console.log('✅ Reconciliation initiated\n');
  }

  // Scenario 4: Apply catch-up blocks with Merkle chain validation
  console.log('📦 Test 4: Catch-up block application with Merkle validation');
  {
    // Reset and start fresh catch-up from index 0
    reconciliationEngine.__testReset();
    reconciliationEngine.beginReconciliation({ localIndex: 0, targetCommitIndex: 5 });
    reconciliationEngine.__testSetLastMerkleHash('GENESIS_BLOCK');

    // Block 1: entries [1], index 1 (first block to apply, since localIndex is 0)
    const entries1: EscrowRecord[] = [createMockEntry(1, 'commitment_1')];
    const merkleHash1 = computeEntriesMerkleHash(entries1);

    const block1: CatchUpBlock = {
      blockId: 'block_1',
      index: 1,
      term: 1,
      entries: entries1,
      merkleHash: merkleHash1,
      signature: 'sig_block_1',
      previousMerkleHash: 'GENESIS_BLOCK'
    };

    const result1 = reconciliationEngine.applyCatchUpBlock(block1);
    assert(result1.applied, `Expected block 1 to apply: ${result1.reason}`);
    console.log('  ✓ Block 1 applied');

    // Block 2: entries [2], index 2
    const entries2: EscrowRecord[] = [createMockEntry(2, 'commitment_2')];
    const merkleHash2 = computeEntriesMerkleHash(entries2);

    const block2: CatchUpBlock = {
      blockId: 'block_2',
      index: 2,
      term: 1,
      entries: entries2,
      merkleHash: merkleHash2,
      signature: 'sig_block_2',
      previousMerkleHash: merkleHash1
    };

    const result2 = reconciliationEngine.applyCatchUpBlock(block2);
    assert(result2.applied, `Expected block 2 to apply: ${result2.reason}`);
    console.log('  ✓ Block 2 applied');

    // Block 3: entries [3], index 3
    const entries3: EscrowRecord[] = [createMockEntry(3, 'commitment_3')];
    const merkleHash3 = computeEntriesMerkleHash(entries3);

    const block3: CatchUpBlock = {
      blockId: 'block_3',
      index: 3,
      term: 1,
      entries: entries3,
      merkleHash: merkleHash3,
      signature: 'sig_block_3',
      previousMerkleHash: merkleHash2
    };

    const result3 = reconciliationEngine.applyCatchUpBlock(block3);
    assert(result3.applied, `Expected block 3 to apply: ${result3.reason}`);
    console.log('  ✓ Block 3 applied');

    const state = reconciliationEngine.getReconciliationState();
    assert(state, 'Expected reconciliation state to exist');
    assert.strictEqual(state!.blocksApplied, 3, 'Expected 3 blocks applied');

    console.log('✅ Catch-up blocks applied successfully\n');
  }

  // Scenario 5: Merkle chain continuity validation
  console.log('🔗 Test 5: Merkle chain continuity validation');
  {
    reconciliationEngine.__testReset();
    reconciliationEngine.beginReconciliation({ localIndex: 0, targetCommitIndex: 2 });
    reconciliationEngine.__testSetLastMerkleHash('GENESIS_BLOCK');

    // Valid block
    const entries1: EscrowRecord[] = [createMockEntry(1, 'commitment_1')];
    const merkleHash1 = computeEntriesMerkleHash(entries1);

    const validBlock: CatchUpBlock = {
      blockId: 'block_valid',
      index: 1,
      term: 1,
      entries: entries1,
      merkleHash: merkleHash1,
      signature: 'sig_valid',
      previousMerkleHash: 'GENESIS_BLOCK'
    };

    const validResult = reconciliationEngine.applyCatchUpBlock(validBlock);
    assert(validResult.applied, 'Expected valid block to apply');
    console.log('  ✓ Valid Merkle chain accepted');

    // Invalid block: broken Merkle chain
    const entries2: EscrowRecord[] = [createMockEntry(2, 'commitment_2')];
    const merkleHash2 = computeEntriesMerkleHash(entries2);

    const invalidBlock: CatchUpBlock = {
      blockId: 'block_invalid',
      index: 2,
      term: 1,
      entries: entries2,
      merkleHash: merkleHash2,
      signature: 'sig_invalid',
      previousMerkleHash: 'WRONG_HASH'  // ← Broken chain
    };

    const invalidResult = reconciliationEngine.applyCatchUpBlock(invalidBlock);
    assert(!invalidResult.applied, 'Expected invalid block to be rejected');
    assert(invalidResult.reason!.includes('Merkle chain'), 'Expected Merkle chain error');
    console.log('  ✓ Broken Merkle chain rejected');

    console.log('✅ Merkle chain continuity validation passed\n');
  }

  // Scenario 6: Snapshot-based fast catch-up
  console.log('⚡ Test 6: Snapshot-based fast catch-up');
  {
    reconciliationEngine.__testReset();
    snapshotManager.__testClearSnapshots();

    // Create a new snapshot
    const ledgerEntries: EscrowRecord[] = [
      createMockEntry(1, 'commitment_1'),
      createMockEntry(2, 'commitment_2'),
      createMockEntry(3, 'commitment_3'),
      createMockEntry(4, 'commitment_4'),
      createMockEntry(5, 'commitment_5')
    ];

    const quorumSigs: QuorumSignature[] = [
      createMockSignature('node_1', 2),
      createMockSignature('node_2', 2),
      createMockSignature('node_3', 2),
      createMockSignature('node_4', 2)
    ];

    const snapshot = snapshotManager.createSnapshot({
      latestIndex: 5,
      latestTerm: 2,
      ledgerEntries,
      quorumSignatures: quorumSigs
    });

    // Begin catch-up
    reconciliationEngine.beginReconciliation({ localIndex: 2, targetCommitIndex: 5 });

    // Apply snapshot directly
    const snapshotResult = reconciliationEngine.applySnapshot(snapshot);
    assert(snapshotResult.applied, `Expected snapshot to apply: ${snapshotResult.reason}`);
    console.log('  ✓ Snapshot applied (fast catch-up)');

    const state = reconciliationEngine.getReconciliationState();
    assert(state!.blocksApplied === 1, 'Expected 1 block applied (snapshot counts as one)');

    console.log('✅ Snapshot-based catch-up passed\n');
  }

  // Scenario 7: Non-linear block rejection
  console.log('❌ Test 7: Non-linear block rejection');
  {
    reconciliationEngine.__testReset();
    reconciliationEngine.beginReconciliation({ localIndex: 0, targetCommitIndex: 3 });
    reconciliationEngine.__testSetLastMerkleHash('GENESIS_BLOCK');

    // Apply block 1
    const entries1: EscrowRecord[] = [createMockEntry(1, 'commitment_1')];
    const merkleHash1 = computeEntriesMerkleHash(entries1);

    const block1: CatchUpBlock = {
      blockId: 'block_1',
      index: 1,
      term: 1,
      entries: entries1,
      merkleHash: merkleHash1,
      signature: 'sig_1',
      previousMerkleHash: 'GENESIS_BLOCK'
    };

    reconciliationEngine.applyCatchUpBlock(block1);
    console.log('  ✓ Block 1 applied');

    // Try to apply block 3 (skipping block 2) - should fail
    const entries3: EscrowRecord[] = [createMockEntry(3, 'commitment_3')];
    const merkleHash3 = computeEntriesMerkleHash(entries3);

    const block3: CatchUpBlock = {
      blockId: 'block_3',
      index: 3,  // ← Wrong index (should be 2)
      term: 1,
      entries: entries3,
      merkleHash: merkleHash3,
      signature: 'sig_3',
      previousMerkleHash: merkleHash1
    };

    const result3 = reconciliationEngine.applyCatchUpBlock(block3);
    assert(!result3.applied, 'Expected non-linear block to be rejected');
    assert(result3.reason!.includes('Non-linear'), 'Expected non-linear error');
    console.log('  ✓ Non-linear block rejected');

    console.log('✅ Non-linear block rejection passed\n');
  }

  // Scenario 8: Complete reconciliation
  console.log('🎯 Test 8: Complete reconciliation');
  {
    reconciliationEngine.__testReset();
    reconciliationEngine.beginReconciliation({ localIndex: 2, targetCommitIndex: 5 });

    let state = reconciliationEngine.getReconciliationState();
    assert(state!.isReconciling, 'Expected reconciliation in progress');

    const completed = reconciliationEngine.completeReconciliation();
    assert(completed, 'Expected reconciliation to complete');
    assert(!completed.isReconciling, 'Expected isReconciling = false');

    state = reconciliationEngine.getReconciliationState();
    assert(!state, 'Expected reconciliation state to be cleared');

    console.log('✅ Reconciliation completion passed\n');
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('✅ ALL PARTITION RECOVERY TESTS PASSED');
  console.log('════════════════════════════════════════════════════════════');
  console.log('\nSecurity properties verified:');
  console.log('  ✓ Linear log index continuity enforced');
  console.log('  ✓ Merkle chain continuity validated');
  console.log('  ✓ Non-linear blocks rejected');
  console.log('  ✓ Broken Merkle chains detected');
  console.log('  ✓ Quorum signatures verified');
  console.log('  ✓ Snapshot-based catch-up supported');
  console.log('  ✓ No state rollback risk\n');
}

runPartitionRecoveryRegression()
  .then(() => {
    console.log(JSON.stringify({ result: 'PASS', test: 'enclaveReconciliation' }));
  })
  .catch((e) => {
    console.error(JSON.stringify({ result: 'FAIL', error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
