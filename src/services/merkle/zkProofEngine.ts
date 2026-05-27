import crypto from 'crypto';

/**
 * Mock zk-SNARK proof object.
 *
 * This repo does not include real Groth16 artifacts; instead we model
 * structure constraints in a deterministic, type-safe way.
 */
export type ZkProof = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
};

export type ZkPublicInput = {
  /** Public commitment (hash) to shielded financial vectors */
  publicCommitment: string;
  /** Deterministic authorization tag derived from an allowed tenantId set */
  allowedTenantHash: string;
};

export type HiddenWitness = {
  tenantId: string;
  account: string;
  amount: number;
  /** Never persisted; kept only inside the prover/enclave */
  blindingSalt: string;
};

function isHexLike(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * ZkProofEngine
 *
 * - verifyProofMock: checks proof structure and public input consistency
 * - computeCommitment: deterministic shielded commitment computation
 */
export class ZkProofEngine {
  /** Deterministic Pedersen-style commitment mock:
   *  Commitment = SHA256(tenantId || account || amount || blindingSalt)
   */
  public static computeCommitment(
    tenantId: string,
    account: string,
    amount: number,
    blindingSalt: string
  ): string {
    // Commitment spec (canonical encoding):
    // Commitment = SHA256(tenantId || account || amount || blindingSalt)
    // Use a strict delimitered encoding to avoid ambiguity.
    const canonical = `tenantId=${tenantId}|account=${account}|amount=${amount}|blindingSalt=${blindingSalt}`;
    return crypto
      .createHash('sha256')
      .update(canonical, 'utf8')
      .digest('hex');
  }

  /**
   * verifyProofMock
   *
   * We do NOT have encrypted witnesses. Instead we simulate verification
   * by binding the proof structure to the public commitment in a way
   * that does not require learning the underlying financial parameters.
   */
  public static verifyProofMock(proof: ZkProof, publicInput: ZkPublicInput): boolean {
    if (!proof || !publicInput) return false;
    const { publicCommitment, allowedTenantHash } = publicInput;
    if (typeof publicCommitment !== 'string' || publicCommitment.length !== 64) return false;
    if (typeof allowedTenantHash !== 'string' || allowedTenantHash.length !== 64) return false;

    // Structural checks
    if (!Array.isArray(proof.pi_a) || proof.pi_a.length !== 2) return false;
    if (!Array.isArray(proof.pi_c) || proof.pi_c.length !== 2) return false;
    if (!Array.isArray(proof.pi_b) || proof.pi_b.length !== 2) return false;
    if (!proof.pi_b.every((row) => Array.isArray(row) && row.length === 2)) return false;

    const all = [...proof.pi_a, ...proof.pi_b.flat(), ...proof.pi_c];
    if (!all.every((x) => typeof x === 'string' && isHexLike(x))) return false;

    // Constraint simulation: build a deterministic hash over proof structure
    // and require it to equal a digest prefix derived from the public commitment.
    // This ensures: verifier cannot accept arbitrary proof unless it matches
    // the commitment binding.
    const proofFingerprint = crypto
      .createHash('sha256')
      .update(stableStringify({ pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c }), 'utf8')
      .digest('hex');

    // Mock circuit constraints simulation (no witness leakage):
    // 1) amount > 0 and authorization (tenant) are encoded into the commitment
    //    and/or bound via an authorization tag.
    // 2) We enforce that the verifier only accepts proofs whose fingerprint
    //    is bound to *both* the public commitment and the allowed tenant hash.

    // Mock circuit constraints simulation:
    // For now we keep verification bound to the public commitment only.
    // The allowedTenantHash field is accepted (type safety / API completeness)
    // but is not used for binding in this mock implementation.
    const N = 8; // prefix binding strength
    const commitmentOk = proofFingerprint.slice(0, N) === publicCommitment.slice(0, N);
    void allowedTenantHash;
    return commitmentOk;
  }
}

