import crypto from 'crypto';
import { EnclaveSealingEngine, type EncryptedSealedBlob, type SealingPolicy } from '../cryptography/EnclaveSealingEngine.js';

export type MigrationPackageMetadata = {
  /** Historical package signer authority. */
  mrsigner: string;
  /** New code measurement expected after upgrade. */
  targetMrenclave: string;
};

export type EnclaveUpgradeMigrationPayload = {
  blob: EncryptedSealedBlob;
  /** Trusted authority describing the new enclave measurement context. */
  metadata: MigrationPackageMetadata;
  /** Audit id for idempotency / trace. */
  migrationId: string;
  /** Signature authenticating the migration package. Fail-closed (host provided). */
  packageSignatureHex: string;
  /** Public key used to verify packageSignatureHex. */
  packagePublicKeyPem: string;
};

export type MigrationResult =
  | { ok: true; newBlob: EncryptedSealedBlob }
  | { ok: false; error: string };

/**
 * EnclaveMigrationManager
 *
 * Deterministic state migration orchestration:
 * - validate trusted authority (MRSIGNER)
 * - unseal under historical policy
 * - immediately re-seal under updated measurement
 * - fail-closed on any integrity/signing/policy mismatch
 */
export class EnclaveMigrationManager {
  constructor(
    private readonly sealingConfig: {
      cpuMasterSecret: string;
      /** Current enclave measurement context for the *running* node. */
      mrsigner: string;
      mrenclave: string;
    }
  ) {}

  public migrateBlob(params: {
    payload: EnclaveUpgradeMigrationPayload;
    trustedMRSIGNER: string;
    /** expected signature over canonical migration header */
    trustedPackagePublicKeyPem: string;
  }): MigrationResult {
    try {
      const { payload, trustedMRSIGNER, trustedPackagePublicKeyPem } = params;

      if (!payload || typeof payload !== 'object') return { ok: false, error: 'MIGRATION_PAYLOAD_MISSING' };
      if (!payload.blob) return { ok: false, error: 'MIGRATION_BLOB_MISSING' };
      if (!payload.metadata) return { ok: false, error: 'MIGRATION_METADATA_MISSING' };
      if (!payload.migrationId || typeof payload.migrationId !== 'string') return { ok: false, error: 'MIGRATION_ID_MISSING' };

      const { blob, metadata } = payload;

      // 1) Verify package signature against canonical header.
      const canonicalHeader = this.canonicalMigrationHeader({ migrationId: payload.migrationId, metadata });
      const signatureOk = this.verifyHexRsaSha256(
        canonicalHeader,
        payload.packageSignatureHex,
        trustedPackagePublicKeyPem
      );
      if (!signatureOk) return { ok: false, error: 'PACKAGE_SIGNATURE_INVALID' };

      // 2) Validate trusted authority (MRSIGNER) matches what blob was bound to.
      if (metadata.mrsigner !== trustedMRSIGNER) return { ok: false, error: 'MRSIGNER_NOT_TRUSTED' };
      if (blob.platform.mrsigner !== trustedMRSIGNER) return { ok: false, error: 'BLOB_MRSIGNER_MISMATCH' };

      // 3) Unseal using the running enclave context.
      //    Historical policy must be preserved: unseal using blob.policy.
      const engineOld = new EnclaveSealingEngine({
        cpuMasterSecret: this.sealingConfig.cpuMasterSecret,
        mrsigner: blob.platform.mrsigner,
        mrenclave: blob.platform.mrenclave
      });

      const plaintext = engineOld.unsealData(blob);

      // 4) Re-seal under updated code measurement.
      //    Policy mapping: preserve the *historical policy binding* semantics.
      //    If policy was MRENCLAVE, reseal under targetMrenclave to make ciphertext usable by new code measurement.
      //    If policy was MRSIGNER, reseal under same MRSIGNER but new MRENCLAVE (still allowed since key derivation omits it).
      const targetMrenclave = metadata.targetMrenclave;
      const engineNew = new EnclaveSealingEngine({
        cpuMasterSecret: this.sealingConfig.cpuMasterSecret,
        mrsigner: trustedMRSIGNER,
        mrenclave: targetMrenclave
      });

      const newBlob = engineNew.sealData(plaintext, blob.policy);

      // Scrub plaintext immediately.
      plaintext.fill(0);

      return { ok: true, newBlob };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'MIGRATION_FAILED' };
    }
  }

  private canonicalMigrationHeader(params: {
    migrationId: string;
    metadata: MigrationPackageMetadata;
  }): string {
    // Stable serialization.
    return `migrationId=${params.migrationId}|mrsigner=${params.metadata.mrsigner}|targetMrenclave=${params.metadata.targetMrenclave}`;
  }

  private verifyHexRsaSha256(data: string, sigHex: string, publicKeyPem: string): boolean {
    try {
      if (!sigHex || !publicKeyPem) return false;
      if (!/^[0-9a-fA-F]+$/.test(sigHex) || sigHex.length % 2 !== 0) return false;
      const sig = Buffer.from(sigHex, 'hex');
      const verifier = crypto.createVerify('sha256');
      verifier.update(Buffer.from(data, 'utf8'));
      verifier.end();
      return verifier.verify(publicKeyPem, sig);
    } catch {
      return false;
    }
  }
}


