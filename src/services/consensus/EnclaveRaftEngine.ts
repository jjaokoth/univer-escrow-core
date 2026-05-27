import { DatabaseService, type EscrowRecord } from '../DatabaseService.js';

export interface RaftLogEntry {
  term: number;
  index: number;
  record: EscrowRecord;
}

export enum RaftRole {
  FOLLOWER = 'FOLLOWER',
  CANDIDATE = 'CANDIDATE',
  LEADER = 'LEADER'
}

export type QuorumAckMatrix = {
  ackCount: number;
  clusterSize: number;
  /** ack signatures bound to (term, index) in real implementations */
  acknowledgments: string[];
};

/**
 * EnclaveRaftEngine
 *
 * This is a deterministic, type-safe in-repo Raft-like engine intended for:
 * - regression simulation
 * - fail-closed quorum enforcement
 *
 * It does NOT implement full networking or timing; those are orchestrated by
 * EnclaveClusterService + HTTP routes.
 */
export class EnclaveRaftEngine {
  private static instance: EnclaveRaftEngine | null = null;

  public currentTerm = 0;
  public currentRole: RaftRole = RaftRole.FOLLOWER;
  public votedFor: string | null = null;
  public log: RaftLogEntry[] = [];
  public commitIndex = 0;

  // fail-closed behavior: if quorum fails, a record never reaches ledger.
  public failClosed = true;

  private constructor() {}

  public static getInstance(): EnclaveRaftEngine {
    if (!EnclaveRaftEngine.instance) {
      EnclaveRaftEngine.instance = new EnclaveRaftEngine();
    }
    return EnclaveRaftEngine.instance;
  }

  /** Reset engine state for deterministic regression runs. */
  public resetEngine(): void {
    this.currentTerm = 0;
    this.currentRole = RaftRole.FOLLOWER;
    this.votedFor = null;
    this.log = [];
    this.commitIndex = 0;
  }

  /** Quorum formula: floor(N/2)+1 */
  public requiredQuorumAcks(clusterSize: number): number {
    return Math.floor(clusterSize / 2) + 1;
  }

  public hasQuorum(ackCount: number, clusterSize: number): boolean {
    return ackCount >= this.requiredQuorumAcks(clusterSize);
  }

  public appendLocalLog(record: EscrowRecord): RaftLogEntry {
    const newIndex = this.log.length + 1;
    const entry: RaftLogEntry = {
      term: this.currentTerm,
      index: newIndex,
      record
    };
    this.log.push(entry);
    return entry;
  }

  /**
   * Legacy majority commit path (kept for backward compatibility).
   * Prefer `commitToLedgerIfBftQuorum()` for cross-enclave verification.
   */
  public async commitToLedgerIfQuorum(
    entryIndex: number,
    quorum: QuorumAckMatrix
  ): Promise<{ committed: boolean; reason?: string }> {
    const entry = this.log.find((e) => e.index === entryIndex);
    if (!entry) return { committed: false, reason: 'MISSING_ENTRY' };

    if (!this.hasQuorum(quorum.ackCount, quorum.clusterSize)) {
      if (this.failClosed) return { committed: false, reason: 'QUORUM_FAILED' };
    }

    if (entryIndex <= this.commitIndex) {
      return { committed: false, reason: 'ALREADY_COMMITTED' };
    }

    await DatabaseService.saveRecord(entry.record);
    this.commitIndex = entryIndex;
    return { committed: true };
  }

  /**
   * Cross-enclave BFT commit.
   *
   * For cluster size N:
   *   f = floor((N-1)/3)
   *   threshold = 2f+1
   *
   * Ledger write is fail-closed: if threshold isn’t met, no disk commit.
   */
  public async commitToLedgerIfBftQuorum(params: {
    entryIndex: number;
    clusterSize: number;
    proposalCommitment: string;
    consensusTerm: number;
    index: number;
    payload: {
      clusterSize: number;
      f: number;
      threshold: number;
      uniqueNodeIds: string[];
      shares: {
        nodeId: string;
        nodePcr0Hash: string;
        consensusTerm: number;
        index: number;
        approvalHash: string;
        nodeSignature: string;
      }[];
    };
  }): Promise<{ committed: boolean; reason?: string }> {
    const entry = this.log.find((e) => e.index === params.entryIndex);
    if (!entry) return { committed: false, reason: 'MISSING_ENTRY' };

    // Fail-closed: entryIndex must be monotonic.
    if (params.entryIndex <= this.commitIndex) {
      return { committed: false, reason: 'ALREADY_COMMITTED' };
    }

    const fExpected = Math.floor((params.clusterSize - 1) / 3);
    const thresholdExpected = 2 * fExpected + 1;

    const payload = params.payload;
    if (!payload) {
      return this.failClosed
        ? { committed: false, reason: 'MISSING_BFT_PAYLOAD' }
        : { committed: false, reason: 'MISSING_BFT_PAYLOAD_NON_FAIL_CLOSED' };
    }

    // Validate payload structural invariants.
    if (payload.clusterSize !== params.clusterSize) return { committed: false, reason: 'PAYLOAD_CLUSTER_SIZE_MISMATCH' };
    if (payload.f !== fExpected) return { committed: false, reason: 'PAYLOAD_F_MISMATCH' };
    if (payload.threshold !== thresholdExpected) return { committed: false, reason: 'PAYLOAD_THRESHOLD_MISMATCH' };

    if (payload.uniqueNodeIds.length < payload.threshold) {
      return { committed: false, reason: 'BFT_THRESHOLD_NOT_REACHED' };
    }

    if (payload.shares.length < payload.threshold) {
      return { committed: false, reason: 'BFT_THRESHOLD_NOT_REACHED' };
    }

    // Commitment/term/index must bind to the log entry being committed.
    if (String(entry.record.escrowRecordLeafHash) !== String(params.proposalCommitment)) {
      return { committed: false, reason: 'COMMITMENT_RECORD_MISMATCH' };
    }
    if (params.consensusTerm !== payload.shares[0]?.consensusTerm) {
      return { committed: false, reason: 'CONSENSUS_TERM_MISMATCH' };
    }
    if (params.index !== payload.shares[0]?.index) {
      return { committed: false, reason: 'INDEX_MISMATCH' };
    }

    // Validate each share corresponds to the exact (term,index,commitment) intent.
    // In this repo the enclave signature is deterministic over (txId, commitment, consensusTerm, nodeSecret).
    // We at least ensure share term/index match; full approvalHash re-validation is handled by the verify engine.
    const nodeIdsSeen = new Set<string>();
    for (const s of payload.shares) {
      if (!s || typeof s.nodeId !== 'string') return { committed: false, reason: 'MALFORMED_SHARE' };
      if (s.consensusTerm !== params.consensusTerm) return { committed: false, reason: 'SHARE_TERM_MISMATCH' };
      if (s.index !== params.index) return { committed: false, reason: 'SHARE_INDEX_MISMATCH' };
      nodeIdsSeen.add(String(s.nodeId));
    }

    if (nodeIdsSeen.size < payload.threshold) {
      return { committed: false, reason: 'BFT_THRESHOLD_NOT_REACHED' };
    }

    await DatabaseService.saveRecord(entry.record);
    this.commitIndex = params.entryIndex;
    return { committed: true };
  }
}



