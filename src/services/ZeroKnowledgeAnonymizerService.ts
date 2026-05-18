/******************************************************
 * ZeroKnowledgeAnonymizerService.ts
 * ----------------------------------------------------
 * Tenant-isolated in-memory proof anonymizer/tokenizer.
 * This module is intentionally lightweight and avoids any
 * expensive cryptographic operations; verification is delegated
 * to an injected, out-of-band validator.
 ******************************************************/

import { createHash } from 'crypto';

export type ProofInputSecretPayload = {
  [k: string]: unknown;
};

export type PublicInputs = {
  [k: string]: unknown;
};

export type ZkAnonymizerTokenPayload = {
  tenantId: string;
  proofCommitment: string;
  proofHash: string;
  publicInputsHash: string;
};

export interface ProofAuthenticityResult {
  ok: true;
  valid: boolean;
  details?: Record<string, unknown>;
}

export interface ProofAuthenticityValidator {
  /**
   * Host-provided (out-of-band) mathematical consistency checks.
   * Must be fast; any heavy cryptographic operations should run off-thread.
   */
  validate(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<boolean>;
}

export interface ProofCommitmentStrategy {
  /**
   * Produce a deterministic commitment for the proof (no secrecy required here).
   * Must not leak additional sensitive material.
   */
  commit(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<string>;
}

export interface ZeroKnowledgeAnonymizerConfig {
  validator: ProofAuthenticityValidator;
  commitment: ProofCommitmentStrategy;
}

/**
 * Provides:
 * - generateAnonymizedProof: tokenizes proof inputs into a deterministic token
 * - evaluateProofAuthenticity: validates mathematical consistency first
 *
 * Tokenization and state updates are kept per tenant+in-memory map.
 */
export class ZeroKnowledgeAnonymizerService {
  private readonly config: ZeroKnowledgeAnonymizerConfig;

  // tenantId -> proofHash -> token data (in-memory boundary)
  private readonly tenantTokens = new Map<string, Map<string, ZkAnonymizerTokenPayload>>();

  constructor(config: ZeroKnowledgeAnonymizerConfig) {
    this.config = config;
  }

  private static stableHashHex(input: unknown): string {
    const canonical = JSON.stringify(input);
    return createHash('sha256').update(canonical).digest('hex');
  }

  private getTenantMap(tenantId: string): Map<string, ZkAnonymizerTokenPayload> {
    let m = this.tenantTokens.get(tenantId);
    if (!m) {
      m = new Map();
      this.tenantTokens.set(tenantId, m);
    }
    return m;
  }

  /**
   * Cross-verify mathematical consistency prior to any downstream state adjustment.
   */
  public async evaluateProofAuthenticity(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<ProofAuthenticityResult> {
    const { tenantId, inputSecretPayload, publicInputs } = params;

    if (!tenantId) throw new Error('tenantId is required');

    const valid = await this.config.validator.validate({
      tenantId,
      inputSecretPayload,
      publicInputs,
    });

    return { ok: true, valid };
  }

  /**
   * Generate a secure non-interactive verification token out-of-band.
   *
   * Token format is a deterministic payload; host can wrap it in JWS/JWE if desired.
   */
  public async generateAnonymizedProof(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<{ token: string; tokenPayload: ZkAnonymizerTokenPayload }> {
    const { tenantId, inputSecretPayload, publicInputs } = params;
    if (!tenantId) throw new Error('tenantId is required');

    // Validate authenticity first.
    const authenticity = await this.evaluateProofAuthenticity({
      tenantId,
      inputSecretPayload,
      publicInputs,
    });

    if (!authenticity.valid) {
      throw new Error('PROOF_AUTHENTICITY_FAILED');
    }

    const publicInputsHash = ZeroKnowledgeAnonymizerService.stableHashHex(publicInputs);
    const proofHash = ZeroKnowledgeAnonymizerService.stableHashHex({
      tenantId,
      secret: inputSecretPayload,
      publicInputs,
    });

    const proofCommitment = await this.config.commitment.commit({
      tenantId,
      inputSecretPayload,
      publicInputs,
    });

    const tokenPayload: ZkAnonymizerTokenPayload = {
      tenantId,
      proofCommitment,
      proofHash,
      publicInputsHash,
    };

    // Store per tenant in isolated memory boundary.
    const tenantMap = this.getTenantMap(tenantId);
    tenantMap.set(proofHash, tokenPayload);

    // Deterministic token string (no secret embedding beyond hashes/commitment).
    const token = JSON.stringify(tokenPayload);
    return { token, tokenPayload };
  }
}
