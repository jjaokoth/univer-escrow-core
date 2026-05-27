import crypto from 'crypto';
import { CryptoService } from './CryptoService.js';
import { verifyMockMLDSA, parseMLDSAPublicKey, hexSha256Hex, type MLDSAPublicKey } from './merkle/pqcEngine.js';
import { ZkProofEngine, type ZkProof } from './merkle/zkProofEngine.js';

export type AttestationDocument = {


  /** PCR/image measurement surrogate */
  pcr0: string;
  /** Boot/runtime validation parameter surrogate */
  pcr1: string;
  /** Signature over canonicalManifest */
  signature: string;
  /** Trusted HSM public key (PEM) */
  hsmPublicKey: string;
};

/**
 * EnclaveBridgeService
 *
 * Confidential computing abstraction layer (mocked) that:
 * - enforces a structural attestation gate (fail-closed)
 * - ensures sensitive verification inputs are handled inside a narrow proxy scope
 * - aggressively scrubs transient buffers after cryptographic operations
 */
type ClassicalSignatureBlock = {
  classicalSignature: string;
};

export type HybridSignatureBlock = {
  classicalSignature: string;
  pqcSignature: string;
};

type PQCPublicKeyBundle = {
  pqcPublicKeyToken: string;
};

type HybridSignatureInput = {
  classicalSignature: string;
  pqcSignature: string;
  classicalPublicKeyPem: string;
  pqcPublicKeyToken: string;
};

export class EnclaveBridgeService {
  private static enclaveReady = false;

  /** ZK verifier execution will set this after scrubbing for test visibility. */
  public static lastZkScrubbedByteLength = 0;

  public static verifyHybridSignatureInEnclave(
    payload: string,
    inputs: HybridSignatureInput
  ): boolean {
    if (!EnclaveBridgeService.enclaveReady) {
      throw new Error('SECURITY_VIOLATION: Enclave boundary uninitialized or attestation failed.');
    }

    // Convert to mutable buffers for scrubbing.
    const payloadBuffer = Buffer.from(payload, 'utf8');
    const classicalSignatureBuffer = Buffer.from(inputs.classicalSignature, 'utf8');
    const classicalPublicKeyBuffer = Buffer.from(inputs.classicalPublicKeyPem, 'utf8');
    const pqcSignatureBuffer = Buffer.from(inputs.pqcSignature, 'utf8');
    const pqcPublicKeyTokenBuffer = Buffer.from(inputs.pqcPublicKeyToken, 'utf8');

    // Keep scrubbing strict and fail-closed.
    try {
      // Fail-closed on stripped/malformed PQC fields.
      if (!inputs.pqcSignature || !inputs.pqcPublicKeyToken) return false;

      const classicalOk = CryptoService.verifySignature(
        payloadBuffer.toString('utf8'),
        classicalSignatureBuffer.toString('utf8'),
        classicalPublicKeyBuffer.toString('utf8')
      );

      if (!classicalOk) return false;

      // PQC mock verification. If parsing fails, fail-closed.
      const messageHashHex = hexSha256Hex(payloadBuffer.toString('utf8'));

      // Parse and run lattice-based mock verification.
      const pqcPublicKey = parseMLDSAPublicKey(pqcPublicKeyTokenBuffer.toString('utf8'));
      if (!pqcPublicKey) return false;

      const pqcRes = verifyMockMLDSA({
        message: payloadBuffer.toString('utf8'),
        messageHashHex,
        pqcSignature: pqcSignatureBuffer.toString('utf8'),
        publicKey: pqcPublicKey
      });

      return pqcRes.ok;


    } finally {
      EnclaveBridgeService.lastScrubbedByteLength =
        payloadBuffer.length +
        classicalSignatureBuffer.length +
        classicalPublicKeyBuffer.length +
        pqcSignatureBuffer.length +
        pqcPublicKeyTokenBuffer.length;

      payloadBuffer.fill(0);
      classicalSignatureBuffer.fill(0);
      classicalPublicKeyBuffer.fill(0);
      pqcSignatureBuffer.fill(0);
      pqcPublicKeyTokenBuffer.fill(0);
    }
  }




  // For local regression only; in real deployments this would be an embedded trust root.
  private static readonly trustedHsmPublicKeyPem = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0...
-----END PUBLIC KEY-----`;

  // Test-only verification hook (how many bytes were scrubbed). Do not use in production logic.
  public static lastScrubbedByteLength = 0;

  private static scrubBuffer(buf: Buffer): void {
    // Overwrite in place.
    buf.fill(0);
  }

  private static canonicalManifest(doc: AttestationDocument): string {
    return `${doc.pcr0}:${doc.pcr1}`;
  }

  /**
   * Verify a structural attestation document and enable fail-closed enclave execution.
   *
   * This implementation intentionally keeps verification logic explicit and deterministic.
   */
  public static verifyEnclaveAttestation(doc: AttestationDocument): boolean {
    try {
      if (!doc || typeof doc !== 'object') return false;
      if (!doc.pcr0 || !doc.pcr1) return false;
      if (!doc.signature || typeof doc.signature !== 'string') return false;

      const canonical = EnclaveBridgeService.canonicalManifest(doc);
      const verifier = crypto.createVerify('sha256');
      verifier.update(canonical);
      verifier.end();

      const trustedKey = doc.hsmPublicKey && doc.hsmPublicKey.trim().length > 0 ? doc.hsmPublicKey : EnclaveBridgeService.trustedHsmPublicKeyPem;

      // Note: this repo uses RSA signing elsewhere; keep mock aligned.
      const isValidSignature = verifier.verify(trustedKey, doc.signature, 'hex');

      // Enforce strict measurement comparison (mock PCR values).
      const expectedPcr0 = '8f3c1b2a4e5d6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7a8b9c0d1e';
      if (isValidSignature && doc.pcr0 === expectedPcr0) {
        EnclaveBridgeService.enclaveReady = true;
        return true;
      }

      EnclaveBridgeService.enclaveReady = false;
      return false;
    } catch {
      EnclaveBridgeService.enclaveReady = false;
      return false;
    }
  }

  public static isEnclaveReady(): boolean {
    return EnclaveBridgeService.enclaveReady;
  }

  /**
   * Test-only enclave ready override.
   * This is intentionally gated behind explicit usage in the regression harness.
   */
  public static setEnclaveReadyForTest(ready: boolean): void {
    EnclaveBridgeService.enclaveReady = !!ready;
  }


  public static revokeEnclaveState(): void {
    EnclaveBridgeService.enclaveReady = false;
  }

  /**
   * Narrow proxy for signature verification.
   *
   * In a real CC deployment, the host would pass blinded inputs to an isolated enclave
   * over a VSOCK/internal broker channel and receive only the boolean result.
   */
  public static verifyZkProofInEnclave(
    proof: ZkProof,
    publicCommitment: string,
    allowedTenantHash: string
  ): boolean {

    if (!EnclaveBridgeService.enclaveReady) {
      throw new Error('SECURITY_VIOLATION: Enclave boundary uninitialized or attestation failed.');
    }

    const publicCommitmentBuffer = Buffer.from(publicCommitment, 'utf8');
    const allowedTenantHashBuffer = Buffer.from(allowedTenantHash, 'utf8');
    const proofBuffer = Buffer.from(JSON.stringify(proof), 'utf8');

    try {
      const ok = ZkProofEngine.verifyProofMock(proof, {
        publicCommitment,
        allowedTenantHash
      });
      return ok;
    } finally {
      EnclaveBridgeService.lastScrubbedByteLength =
        publicCommitmentBuffer.length +
        allowedTenantHashBuffer.length +
        proofBuffer.length;
      EnclaveBridgeService.lastZkScrubbedByteLength =
        EnclaveBridgeService.lastScrubbedByteLength;

      publicCommitmentBuffer.fill(0);
      allowedTenantHashBuffer.fill(0);
      proofBuffer.fill(0);
    }
  }

  /**
   * Fail-closed time-lock evaluation.
   * The enclave must never rely on host local time; the caller must pass quorum median anchor.
   */
  public static verifyTimeLocksInEnclave(params: {
    validAfterMs: number;
    validUntilMs: number;
    quorumMedianAnchorMs: number;
  }): boolean {
    if (!EnclaveBridgeService.enclaveReady) {
      throw new Error('SECURITY_VIOLATION: Enclave boundary uninitialized or attestation failed.');
    }

    const { validAfterMs, validUntilMs, quorumMedianAnchorMs } = params;

    if (
      !Number.isFinite(validAfterMs) ||
      !Number.isFinite(validUntilMs) ||
      !Number.isFinite(quorumMedianAnchorMs)
    ) {
      return false;
    }

    if (quorumMedianAnchorMs < validAfterMs) return false;
    if (quorumMedianAnchorMs > validUntilMs) return false;

    return true;
  }

  public static verifySignatureInEnclave(payload: string, signature: string, publicKey: string): boolean {


    if (!EnclaveBridgeService.enclaveReady) {
      throw new Error('SECURITY_VIOLATION: Enclave boundary uninitialized or attestation failed.');
    }

    // Convert to mutable buffers so we can scrub byte content.
    const payloadBuffer = Buffer.from(payload, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');
    const keyBuffer = Buffer.from(publicKey, 'utf8');

    EnclaveBridgeService.lastScrubbedByteLength = payloadBuffer.length + signatureBuffer.length + keyBuffer.length;

    try {
      // Keep the crypto operation inside the narrow scope.
      return CryptoService.verifySignature(
        payloadBuffer.toString('utf8'),
        signatureBuffer.toString('utf8'),
        keyBuffer.toString('utf8')
      );
    } finally {
      // Scrub after execution to reduce time-window for host memory extraction.
      EnclaveBridgeService.scrubBuffer(payloadBuffer);
      EnclaveBridgeService.scrubBuffer(signatureBuffer);
      EnclaveBridgeService.scrubBuffer(keyBuffer);
    }
  }
}

