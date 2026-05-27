import crypto from 'crypto';
import type { EscrowRecord } from '../DatabaseService.js';
import { EnclaveSnapshotManager, type EpochStateSnapshot } from './EnclaveSnapshotManager.js';


/**
 * EnclaveReconciliationEngine
 *
 * Partition recovery catch-up tracker and reconciliation processor.
 */

export type CatchUpBlock = {
  blockId: string;
  index: number;
  term: number;
  entries: EscrowRecord[];
  merkleHash: string;
  signature: string;
  previousMerkleHash: string;
};

export type ReconciliationState = {
  isReconciling: boolean;
  startedAt: number;
  localIndex: number;
  targetCommitIndex: number;
  blocksApplied: number;
  lastAppliedMerkleHash: string;
};

export class EnclaveReconciliationEngine {
  private static instance: EnclaveReconciliationEngine | null = null;
  private reconciliationState: ReconciliationState | null = null;
  private appliedBlocks: Map<number, CatchUpBlock> = new Map();
  private lastAppliedMerkleHash: string = 'GENESIS_BLOCK';

  private constructor() {}

  public static getInstance(): EnclaveReconciliationEngine {
    if (!EnclaveReconciliationEngine.instance) {
      EnclaveReconciliationEngine.instance = new EnclaveReconciliationEngine();
    }
    return EnclaveReconciliationEngine.instance;
  }

  public detectLag(localIndex: number, clusterCommitIndex: number): boolean {
    return localIndex < clusterCommitIndex;
  }

  public beginReconciliation(params: { localIndex: number; targetCommitIndex: number }): ReconciliationState {
    this.reconciliationState = {
      isReconciling: true,
      startedAt: Date.now(),
      localIndex: params.localIndex,
      targetCommitIndex: params.targetCommitIndex,
      blocksApplied: 0,
      lastAppliedMerkleHash: this.lastAppliedMerkleHash
    };

    this.appliedBlocks.clear();
    return this.reconciliationState;
  }

  public applyCatchUpBlock(block: CatchUpBlock): { applied: boolean; reason?: string } {
    if (!this.reconciliationState || !this.reconciliationState.isReconciling) {
      return { applied: false, reason: 'No active reconciliation' };
    }

    const lastAppliedIndex = this.appliedBlocks.size > 0
      ? Math.max(...this.appliedBlocks.keys())
      : this.reconciliationState.localIndex;

    const expectedIndex = lastAppliedIndex + 1;
    if (block.index !== expectedIndex) {
      return { applied: false, reason: `Non-linear block index: expected ${expectedIndex}, got ${block.index}` };
    }

    if (block.previousMerkleHash !== this.lastAppliedMerkleHash) {
      return { applied: false, reason: 'Merkle chain broken: previous hash mismatch' };
    }

    const expectedMerkleHash = this.computeBlockMerkleHash(block.entries);
    if (block.merkleHash !== expectedMerkleHash) {
      return { applied: false, reason: 'Block Merkle hash invalid' };
    }

    if (typeof block.signature !== 'string' || block.signature.length === 0) {
      return { applied: false, reason: 'Block missing valid signature' };
    }

    this.appliedBlocks.set(block.index, block);
    this.lastAppliedMerkleHash = block.merkleHash;

    this.reconciliationState.blocksApplied += 1;
    this.reconciliationState.lastAppliedMerkleHash = block.merkleHash;

    return { applied: true };
  }

  public applySnapshot(snapshot: EpochStateSnapshot): { applied: boolean; reason?: string } {
    if (!this.reconciliationState || !this.reconciliationState.isReconciling) {
      return { applied: false, reason: 'No active reconciliation' };
    }

    const snapshotManager = EnclaveSnapshotManager.getInstance();
    const validation = snapshotManager.validateSnapshot(snapshot);
    if (!validation.valid) {
      return { applied: false, reason: `Snapshot validation failed: ${validation.reason}` };
    }

    this.lastAppliedMerkleHash = snapshot.metadata.merkleRootHash;
    this.reconciliationState.blocksApplied += 1;
    this.reconciliationState.localIndex = snapshot.metadata.latestIndex;
    this.reconciliationState.lastAppliedMerkleHash = snapshot.metadata.merkleRootHash;

    return { applied: true };
  }

  public completeReconciliation(): ReconciliationState | null {
    if (!this.reconciliationState) return null;
    const completed: ReconciliationState = { ...this.reconciliationState, isReconciling: false };
    this.reconciliationState = null;
    return completed;
  }

  public getReconciliationState(): ReconciliationState | null {
    return this.reconciliationState ? { ...this.reconciliationState } : null;
  }

  public isReconciling(): boolean {
    return this.reconciliationState?.isReconciling ?? false;
  }

  public __testReset(): void {
    this.reconciliationState = null;
    this.appliedBlocks.clear();
    this.lastAppliedMerkleHash = 'GENESIS_BLOCK';
  }

  /** Test-only: override last applied merkle hash for deterministic tests */
  public __testSetLastMerkleHash(hash: string): void {
    this.lastAppliedMerkleHash = hash;
  }


  public getAppliedBlocks(): CatchUpBlock[] {
    return Array.from(this.appliedBlocks.values()).sort((a, b) => a.index - b.index);
  }

  private computeBlockMerkleHash(entries: EscrowRecord[]): string {
    if (entries.length === 0) return crypto.createHash('sha256').update('EMPTY').digest('hex');

    let current = crypto.createHash('sha256').update(JSON.stringify(entries[0])).digest('hex');
    for (let i = 1; i < entries.length; i++) {
      const entryHash = crypto.createHash('sha256').update(JSON.stringify(entries[i])).digest('hex');
      current = crypto.createHash('sha256').update(current + entryHash).digest('hex');
    }
    return current;
  }
}

