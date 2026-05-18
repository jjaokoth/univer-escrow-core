/******************************************************
 * ArbitrationConsensusService.ts
 * ----------------------------------------------------
 * Tenant-isolated, in-memory multi-party consensus tracker.
 * This is orchestration logic only; host wiring can persist
 * or verify signature payloads out-of-band.
 ******************************************************/

import { createHash } from 'crypto';

export type SignaturePayload = {
  // Host may include any payload fields; we keep the type open.
  [k: string]: unknown;
};

export type ConsensusState = {
  tenantId: string;
  transactionId: string;
  // participantPublicKey -> signature validity/record
  signatures: Map<string, { participantPublicKey: string; signatureHash: string; payload: SignaturePayload; weight: number; }>;
  // Computed per transaction
  totalWeight: number;
  requiredWeight: number;
};

export interface ArbitrationConsensusConfig {
  // Required total weight to reach consensus.
  requiredWeight: number;
  // Map public keys to weight; host can adapt.
  participantWeightProvider: (participantPublicKey: string) => number;
  // Fast, non-blocking, deterministic signature validity check.
  // If host already verified signature cryptographically out-of-band,
  // it can return true based on signaturePayload.
  signatureValidator: (params: {
    tenantId: string;
    transactionId: string;
    participantPublicKey: string;
    signaturePayload: SignaturePayload;
  }) => Promise<boolean>;
}

function stableHashHex(input: unknown): string {
  const canonical = JSON.stringify(input);
  return createHash('sha256').update(canonical).digest('hex');
}

export class ArbitrationConsensusService {
  private readonly config: ArbitrationConsensusConfig;

  // tenantId -> (transactionId -> consensus state)
  private readonly byTenant = new Map<string, Map<string, ConsensusState>>();

  constructor(config: ArbitrationConsensusConfig) {
    this.config = config;
  }

  private getOrCreateState(tenantId: string, transactionId: string): ConsensusState {
    let txMap = this.byTenant.get(tenantId);
    if (!txMap) {
      txMap = new Map();
      this.byTenant.set(tenantId, txMap);
    }

    const existing = txMap.get(transactionId);
    if (existing) return existing;

    const created: ConsensusState = {
      tenantId,
      transactionId,
      signatures: new Map(),
      totalWeight: 0,
      requiredWeight: this.config.requiredWeight,
    };
    txMap.set(transactionId, created);
    return created;
  }

  /**
   * Register a participant signature for a transaction.
   * This function performs a fast out-of-band validator call.
   */
  public async registerConsensusSignature(params: {
    tenantId: string;
    transactionId: string;
    participantPublicKey: string;
    signaturePayload: SignaturePayload;
  }): Promise<{ ok: true; participantPublicKey: string; accepted: true; signatureHash: string }> {
    const { tenantId, transactionId, participantPublicKey, signaturePayload } = params;

    if (!tenantId) throw new Error('tenantId is required');
    if (!transactionId) throw new Error('transactionId is required');
    if (!participantPublicKey) throw new Error('participantPublicKey is required');

    // Validate out-of-band (host-provided cryptographic verifier).
    const accepted = await this.config.signatureValidator({
      tenantId,
      transactionId,
      participantPublicKey,
      signaturePayload,
    });

    if (!accepted) {
      // Keep state locked: do not add weight for invalid signatures.
      throw new Error('INVALID_SIGNATURE_PAYLOAD');
    }

    const state = this.getOrCreateState(tenantId, transactionId);

    // Idempotency: if already present, do not double-count.
    if (state.signatures.has(participantPublicKey)) {
      const existing = state.signatures.get(participantPublicKey)!;
      return {
        ok: true,
        participantPublicKey,
        accepted: true,
        signatureHash: existing.signatureHash,
      };
    }

    const weight = this.config.participantWeightProvider(participantPublicKey);
    const signatureHash = stableHashHex({ tenantId, transactionId, participantPublicKey, signaturePayload });

    state.signatures.set(participantPublicKey, {
      participantPublicKey,
      signatureHash,
      payload: signaturePayload,
      weight,
    });

    state.totalWeight += weight;

    return { ok: true, participantPublicKey, accepted: true, signatureHash };
  }

  /**
   * Determine whether consensus threshold has been achieved.
   */
  public evaluateConsensusThreshold(params: {
    tenantId: string;
    transactionId: string;
  }): { ok: true; reached: boolean; totalWeight: number; requiredWeight: number } {
    const { tenantId, transactionId } = params;
    const txMap = this.byTenant.get(tenantId);
    const state = txMap?.get(transactionId);

    if (!state) {
      return { ok: true, reached: false, totalWeight: 0, requiredWeight: this.config.requiredWeight };
    }

    const reached = state.totalWeight >= state.requiredWeight;
    return { ok: true, reached, totalWeight: state.totalWeight, requiredWeight: state.requiredWeight };
  }
}

