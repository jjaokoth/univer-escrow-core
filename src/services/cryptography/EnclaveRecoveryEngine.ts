import crypto from 'crypto';

import { sha256Hex } from '../merkle/sha256.js';
import { EnclaveBridgeService } from '../EnclaveBridgeService.js';

export type EncryptedShareEnvelope = {
  epoch: number;
  masterSecretId: string;
  recipientNodeId: string;
  encryptedShareBlobs: string[];
  shareIndices: number[];
  envelopeHash: string;
};

export type ReconstructedNodeShare = {
  nodeId: string;
  shareIndex: number;
  // plaintext share bytes hex reconstructed after reboot (mocked)
  shareBytesHex: string;
};

export type RecoveryReceipt = {
  recovered: boolean;
  epoch: number;
  masterSecretId: string;
  reconstructedMasterSecretHex?: string;
  recoveryAuditHash: string;
};

function assertFiniteNumber(n: unknown): asserts n is number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error('INVALID_NUMBER');
  }
}

/**
 * EnclaveRecoveryEngine
 *
 * Cold recovery bootstrap orchestrator.
 *
 * In this repo, reconstruction is deterministic mock reconstruction:
 * - master secret is recomputed from (masterSecretId, epoch) and the threshold shares.
 * - This is fail-closed with respect to threshold size.
 */
export class EnclaveRecoveryEngine {
  private static instance: EnclaveRecoveryEngine | null = null;

  private constructor() {}

  public static getInstance(): EnclaveRecoveryEngine {
    if (!EnclaveRecoveryEngine.instance) {
      EnclaveRecoveryEngine.instance = new EnclaveRecoveryEngine();
    }
    return EnclaveRecoveryEngine.instance;
  }

  public recoverMasterSecretFromShares(params: {
    epoch: number;
    masterSecretId: string;
    threshold: number;
    shares: ReconstructedNodeShare[];
  }): RecoveryReceipt {
    if (!EnclaveBridgeService.isEnclaveReady()) {
      throw new Error('SECURITY_VIOLATION: enclave not ready for cold recovery');
    }

    assertFiniteNumber(params.epoch);
    if (typeof params.masterSecretId !== 'string' || params.masterSecretId.length === 0) {
      throw new Error('INVALID_MASTER_SECRET_ID');
    }
    if (!Number.isFinite(params.threshold) || params.threshold <= 0) {
      throw new Error('INVALID_THRESHOLD');
    }

    // fail-closed: require distinct node IDs and threshold shares.
    const distinct = new Map<string, ReconstructedNodeShare>();
    for (const s of params.shares) {
      if (!s || typeof s.nodeId !== 'string') continue;
      if (distinct.has(s.nodeId)) continue;
      if (!Number.isFinite(s.shareIndex) || s.shareIndex <= 0) continue;
      if (typeof s.shareBytesHex !== 'string' || s.shareBytesHex.length === 0) continue;
      distinct.set(s.nodeId, s);
    }

    if (distinct.size < params.threshold) {
      return {
        recovered: false,
        epoch: params.epoch,
        masterSecretId: params.masterSecretId,
        recoveryAuditHash: sha256Hex(`RECOVERY_FAIL|${params.masterSecretId}|${params.epoch}|size=${distinct.size}`)
      };
    }

    // Deterministic mock reconstruction.
    const sortedShares = Array.from(distinct.values()).sort((a, b) => a.shareIndex - b.shareIndex);

    const reconstructionSeed = sha256Hex(
      `RECONSTRUCT_SEED_V1|${params.masterSecretId}|${params.epoch}|${sortedShares.map((x) => x.shareIndex).join(',')}`
    );

    // Use share bytes as additional input; in production you would use polynomial interpolation.
    const sharesMaterial = sha256Hex(sortedShares.map((x) => x.shareBytesHex).join('|'));

    const masterSecretHex = sha256Hex(`MASTER_SECRET_DERIVE_V1|${reconstructionSeed}|${sharesMaterial}`);

    const recoveryAuditHash = sha256Hex(
      `RECOVERY_AUDIT_V1|${params.masterSecretId}|${params.epoch}|threshold=${params.threshold}|nodes=${sortedShares.map((x) => x.nodeId).join(',')}|master=${masterSecretHex}`
    );

    return {
      recovered: true,
      epoch: params.epoch,
      masterSecretId: params.masterSecretId,
      reconstructedMasterSecretHex: masterSecretHex,
      recoveryAuditHash
    };
  }
}

