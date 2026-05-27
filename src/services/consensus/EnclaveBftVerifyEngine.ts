import crypto from 'crypto';
import { sha256Hex } from '../merkle/sha256.js';
import { EnclaveBridgeService, type AttestationDocument } from '../EnclaveBridgeService.js';
import { EnclaveClusterService } from './EnclaveClusterService.js';
import { EnclaveTimeAnchorService, type MedianTimeAnchor } from './EnclaveTimeAnchorService.js';
import type { EscrowRecord } from '../DatabaseService.js';

export type NodeId = string;

export type ZkPublicCommitment = {
  /** Opaque string representing the ZK public commitment. */
  commitment: string;
};

export type PqcHybridSignatureInput = {
  /** Classical signature component (mock structural validation). */
  classicalSignature: string;
  /** PQC lattice signature component (mock structural validation). */
  pqcSignature: string;
};

export type StateTransitionProposal = {
  transactionId: string;
  /** Blind ledger commitment leaf hash (must match the record leaf) */
  commitment: string;
  /** Consensus term used for replay/rollback binding */
  consensusTerm: number;
  /** Monotonic log index (useful for auditability and fork differentiation). */
  index: number;
  /** ZK privacy shielding public commitment (structural checks only in this repo). */
  zkPublicCommitment: ZkPublicCommitment;
  /** PQC hybrid signature structural inputs (structural checks only in this repo). */
  hybridSignature: PqcHybridSignatureInput;
  /** Time constraints parameters for fail-closed gating. */
  timeLocks: {
    validAfterMs: number;
    validUntilMs: number;
    quorumMedianAnchor: MedianTimeAnchor;
  };
  /** Ledger record to be committed (used only to tie commitment to actual leaf). */
  record: EscrowRecord;
};

export type VerificationShare = {
  nodeId: NodeId;
  /** Node PCR0 token/hash binding identity (opaque, structural only). */
  nodePcr0Hash: string;
  consensusTerm: number;
  index: number;
  /** approvalHash is deterministic over (txId, commitment, term, index, nodeId) */
  approvalHash: string;
  /** NodeSignature = sha256(transactionId || commitment || consensusTerm || nodeSecret) */
  nodeSignature: string;
};

export type ThresholdMultiSigPayload = {
  clusterSize: number;
  f: number;
  threshold: number; // 2f+1
  uniqueNodeIds: NodeId[];
  shares: VerificationShare[];
};

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function normalizeString(s: unknown): string {
  return typeof s === 'string' ? s : String(s ?? '');
}

function stableNodeSignatureInput(opts: {
  transactionId: string;
  commitment: string;
  consensusTerm: number;
  nodeSecret: string;
}): string {
  // Domain separation so the signature can’t be confused with other hashes.
  return `ENCLAVE_NODE_SIGNATURE_V1|${opts.transactionId}|${opts.commitment}|${opts.consensusTerm}|${opts.nodeSecret}`;
}

export class EnclaveBftVerifyEngine {
  /** In-repo node secret used only for deterministic regression signatures. */
  private readonly nodeSecret: string;

  constructor(opts?: { nodeSecret?: string }) {
    this.nodeSecret = opts?.nodeSecret ?? 'inrepo-node-secret';
  }

  public static quorumThreshold(clusterSize: number): { f: number; threshold: number } {
    const f = Math.floor((clusterSize - 1) / 3);
    const threshold = 2 * f + 1;
    return { f, threshold };
  }

  private static anchorFingerprint(params: MedianTimeAnchor): string {
    // Deterministic fingerprint binding used for fail-closed anchor tamper detection.
    // IMPORTANT: Fingerprint derivation must NOT include `anchorFingerprint` itself,
    // otherwise it becomes a fixed-point problem.
    return sha256Hex(
      JSON.stringify({
        anchorMs: params.anchorMs,
        includedNodeIds: params.includedNodeIds,
        outlierNodeIds: params.outlierNodeIds
      })
    );
  }

  /**
   * Compute deterministic node signature according to spec:
   * NodeSignature = SHA256(transactionId || commitment || consensusTerm || nodeSecret)
   */
  public computeNodeSignature(params: {
    transactionId: string;
    commitment: string;
    consensusTerm: number;
  }): string {
    const input = stableNodeSignatureInput({
      transactionId: params.transactionId,
      commitment: params.commitment,
      consensusTerm: params.consensusTerm,
      nodeSecret: this.nodeSecret
    });
    return sha256Hex(input);
  }

  public verifyProposalStructurally(proposal: StateTransitionProposal): { ok: boolean; reason?: string } {
    try {
      if (!proposal) return { ok: false, reason: 'MISSING_PROPOSAL' };
      if (typeof proposal.transactionId !== 'string' || proposal.transactionId.length === 0) {
        return { ok: false, reason: 'INVALID_TRANSACTION_ID' };
      }
      if (typeof proposal.commitment !== 'string' || proposal.commitment.length === 0) {
        return { ok: false, reason: 'INVALID_COMMITMENT' };
      }
      if (!isFiniteNumber(proposal.consensusTerm)) return { ok: false, reason: 'INVALID_CONSENSUS_TERM' };
      if (!isFiniteNumber(proposal.index)) return { ok: false, reason: 'INVALID_INDEX' };

      if (!proposal.zkPublicCommitment || typeof proposal.zkPublicCommitment !== 'object') {
        return { ok: false, reason: 'MISSING_ZK_PUBLIC_COMMITMENT' };
      }
      if (typeof proposal.zkPublicCommitment.commitment !== 'string' || proposal.zkPublicCommitment.commitment.length === 0) {
        return { ok: false, reason: 'INVALID_ZK_PUBLIC_COMMITMENT' };
      }

      if (!proposal.hybridSignature || typeof proposal.hybridSignature !== 'object') {
        return { ok: false, reason: 'MISSING_HYBRID_SIGNATURE' };
      }
      const hs = proposal.hybridSignature;
      if (typeof hs.classicalSignature !== 'string' || hs.classicalSignature.length === 0) {
        return { ok: false, reason: 'INVALID_CLASSICAL_SIGNATURE_COMPONENT' };
      }
      if (typeof hs.pqcSignature !== 'string' || hs.pqcSignature.length === 0) {
        return { ok: false, reason: 'INVALID_PQC_SIGNATURE_COMPONENT' };
      }

      if (!proposal.timeLocks || typeof proposal.timeLocks !== 'object') {
        return { ok: false, reason: 'MISSING_TIME_LOCKS' };
      }
      const tl = proposal.timeLocks;
      if (!isFiniteNumber(tl.validAfterMs) || !isFiniteNumber(tl.validUntilMs)) {
        return { ok: false, reason: 'INVALID_TIMELOCK_WINDOW' };
      }
      if (!tl.quorumMedianAnchor) return { ok: false, reason: 'MISSING_QUORUM_MEDIAN_ANCHOR' };
      if (!isFiniteNumber(tl.quorumMedianAnchor.anchorMs)) {
        return { ok: false, reason: 'INVALID_ANCHOR_MS' };
      }

      // Fail-closed: anchorFingerprint must match deterministic recomputation.
      if (!tl.quorumMedianAnchor.anchorFingerprint || typeof tl.quorumMedianAnchor.anchorFingerprint !== 'string') {
        return { ok: false, reason: 'INVALID_ANCHOR_FINGERPRINT' };
      }

      const recomputedFp = EnclaveBftVerifyEngine.anchorFingerprint(tl.quorumMedianAnchor);
      if (String(recomputedFp) !== String(tl.quorumMedianAnchor.anchorFingerprint)) {
        return { ok: false, reason: 'ANCHOR_FINGERPRINT_MISMATCH' };
      }

      if (!proposal.record) return { ok: false, reason: 'MISSING_RECORD' };

      return { ok: true };
    } catch {
      return { ok: false, reason: 'PROPOSAL_STRUCTURAL_EXCEPTION' };
    }
  }

  /**
   * Fail-closed cryptographic gating.
   * In-repo: ZK/PQC verification is structural; time locks use enclave-ready gate.
   */
  public verifyProposalAndBuildShare(params: {
    proposal: StateTransitionProposal;
    nodeId: NodeId;
    nodePcr0Hash: string;
  }): { ok: boolean; share?: VerificationShare; reason?: string } {
    try {
      // Fail-closed enclave boundary.
      if (!EnclaveBridgeService.isEnclaveReady()) {
        return { ok: false, reason: 'ENCLAVE_NOT_READY' };
      }

      const structural = this.verifyProposalStructurally(params.proposal);
      if (!structural.ok) return structural;

      const proposal = params.proposal;

      // Verify the record commitment matches provided commitment.
      // Ledger leaf commitment hash in this repo is stored in `escrowRecordLeafHash`.
      if (String(proposal.record.escrowRecordLeafHash) !== String(proposal.commitment)) {
        return { ok: false, reason: 'COMMITMENT_RECORD_MISMATCH' };
      }

      // Time-lock verification (median anchor gate).
      // We use EnclaveBridgeService.verifyTimeLocksInEnclave which is fail-closed.
      const okTimes = EnclaveBridgeService.verifyTimeLocksInEnclave({
        validAfterMs: proposal.timeLocks.validAfterMs,
        validUntilMs: proposal.timeLocks.validUntilMs,
        quorumMedianAnchorMs: proposal.timeLocks.quorumMedianAnchor.anchorMs
      });
      if (!okTimes) return { ok: false, reason: 'TIME_LOCKS_REJECTED' };

      // Structural ZK/PQC checks (fail-closed on missing fields already ensured).
      // If later the repo adds true ZK/PQC verification, wire it here.

      const nodeSignature = this.computeNodeSignature({
        transactionId: proposal.transactionId,
        commitment: proposal.commitment,
        consensusTerm: proposal.consensusTerm
      });

      const approvalHash = sha256Hex(
        `ENCLAVE_BFT_APPROVAL_V1|${proposal.transactionId}|${proposal.commitment}|${proposal.consensusTerm}|${proposal.index}|${params.nodeId}`
      );

      const share: VerificationShare = {
        nodeId: params.nodeId,
        nodePcr0Hash: params.nodePcr0Hash,
        consensusTerm: proposal.consensusTerm,
        index: proposal.index,
        approvalHash,
        nodeSignature
      };

      return { ok: true, share };
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? 'SHARE_BUILD_EXCEPTION' };
    }
  }

  public aggregateShares(params: {
    proposal: StateTransitionProposal;
    shares: VerificationShare[];
    nodeIdToAttestationPcr0Hash: Map<NodeId, string>;
  }): { ok: boolean; payload?: ThresholdMultiSigPayload; reason?: string } {
    try {
      const clusterSize = EnclaveClusterService.getClusterSize();
      const { f, threshold } = EnclaveBftVerifyEngine.quorumThreshold(clusterSize);

      // Only count distinct node IDs.
      const unique = new Map<NodeId, VerificationShare>();
      for (const s of params.shares) {
        if (!s || typeof s.nodeId !== 'string') continue;
        if (s.consensusTerm !== params.proposal.consensusTerm) continue;
        if (s.index !== params.proposal.index) continue;

        // Attestation gate for identity (structural): we only count if it appears in attestation-derived map.
        const expectedPcr0 = params.nodeIdToAttestationPcr0Hash.get(s.nodeId);
        if (!expectedPcr0) continue;
        if (expectedPcr0 !== s.nodePcr0Hash) continue;

        unique.set(s.nodeId, s);
      }

      const sharesArr = Array.from(unique.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
      if (sharesArr.length < threshold) {
        return { ok: false, reason: 'THRESHOLD_NOT_REACHED' };
      }

      const payload: ThresholdMultiSigPayload = {
        clusterSize,
        f,
        threshold,
        uniqueNodeIds: sharesArr.map((x) => x.nodeId),
        shares: sharesArr
      };

      return { ok: true, payload };
    } catch {
      return { ok: false, reason: 'AGGREGATION_EXCEPTION' };
    }
  }
}

