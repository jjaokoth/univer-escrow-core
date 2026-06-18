import crypto from 'crypto';

export type SealingPolicy = 'MRENCLAVE' | 'MRSIGNER';

export type EncryptedSealedBlob = {
  version: 1;
  policy: SealingPolicy;
  /** Platform identifiers bound at sealing time. */
  platform: {
    cpuPlatformId: string;
    mrsigner: string;
    mrenclave: string;
  };
  /** Domain separated salt (policy + platform). */
  dkSaltHex: string;
  /** AES-GCM nonce (12 bytes). */
  nonceHex: string;
  /** AES-GCM ciphertext. */
  ciphertextHex: string;
  /** AES-GCM authentication tag (16 bytes). */
  tagHex: string;
  /** Used to re-derive key deterministically. */
  keyId: string;
  /** Timestamp for auditability. */
  sealedAtMs: number;
};

export type EnclaveSealingConfig = {
  cpuMasterSecret: string;
  mrsigner: string;
  mrenclave: string;
};

/**
 * EnclaveSealingEngine
 *
 * Hardware-bound sealing simulation using deterministic HKDF + AES-256-GCM.
 *
 * Fail-closed unseal: any integrity failure or policy/platform mismatch throws.
 */
export class EnclaveSealingEngine {
  private readonly cpuMasterSecret: string;
  private readonly cpuPlatformId: string;
  private readonly mrsigner: string;
  private readonly mrenclave: string;

  constructor(config: EnclaveSealingConfig) {
    this.cpuMasterSecret = String(config.cpuMasterSecret);
    this.mrsigner = String(config.mrsigner);
    this.mrenclave = String(config.mrenclave);
    this.cpuPlatformId = this.computeCpuPlatformId();
  }

  public sealData(plaintext: Buffer, policy: SealingPolicy): EncryptedSealedBlob {
    if (!Buffer.isBuffer(plaintext)) {
      throw new TypeError('plaintext must be a Buffer');
    }
    if (plaintext.length === 0) {
      throw new Error('plaintext must not be empty');
    }

    const dkSaltHex = this.computeDkSaltHex(policy);
    const keyId = this.computeKeyId(policy);

    const key = this.deriveAesKey(policy, dkSaltHex);
    const nonce = crypto.randomBytes(12);

    // Bind policy + platform identifiers to ciphertext via AES-GCM AAD.
    const aad = this.canonicalAad(policy);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();


    // Scrub transient sensitive buffers.
    this.scrubBuffer(key);

    return {
      version: 1,
      policy,
      platform: {
        cpuPlatformId: this.cpuPlatformId,
        mrsigner: this.mrsigner,
        mrenclave: this.mrenclave
      },
      dkSaltHex,
      nonceHex: nonce.toString('hex'),
      ciphertextHex: ciphertext.toString('hex'),
      tagHex: tag.toString('hex'),
      keyId,
      sealedAtMs: Date.now()
    };
  }

  public unsealData(blob: EncryptedSealedBlob): Buffer {
    if (!blob || typeof blob !== 'object') {

      throw new TypeError('blob must be an EncryptedSealedBlob');
    }

    if (blob.version !== 1) {
      throw new Error('UNSEAL_FAILED: unsupported blob version');
    }

    // Policy/platform mismatch must fail-closed.
    if (blob.platform.cpuPlatformId !== this.cpuPlatformId) {
      throw new Error('UNSEAL_FAILED: CPU platform identity mismatch');
    }
    if (blob.platform.mrsigner !== this.mrsigner) {
      throw new Error('UNSEAL_FAILED: MRSIGNER mismatch');
    }
    if (blob.platform.mrenclave !== this.mrenclave) {
      throw new Error('UNSEAL_FAILED: MRENCLAVE mismatch');
    }

    const policy = blob.policy;
    if (policy !== 'MRENCLAVE' && policy !== 'MRSIGNER') {
      throw new Error('UNSEAL_FAILED: invalid policy');
    }

    const expectedDkSaltHex = this.computeDkSaltHex(policy);
    if (blob.dkSaltHex !== expectedDkSaltHex) {
      throw new Error('UNSEAL_FAILED: dkSaltHex mismatch');
    }

    const expectedKeyId = this.computeKeyId(policy);
    if (blob.keyId !== expectedKeyId) {
      throw new Error('UNSEAL_FAILED: keyId mismatch');
    }

    const key = this.deriveAesKey(policy, blob.dkSaltHex);

    const nonce = Buffer.from(blob.nonceHex, 'hex');
    const ciphertext = Buffer.from(blob.ciphertextHex, 'hex');
    const tag = Buffer.from(blob.tagHex, 'hex');

    if (nonce.length !== 12) {
      throw new Error('UNSEAL_FAILED: invalid nonce length');
    }

    const aad = this.canonicalAad(policy);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      // Node16/CommonJS types may model cipher.update/final as ArrayBuffer-like.
      const p1 = decipher.update(ciphertext as any) as Buffer;
      const p2 = decipher.final() as Buffer;
      return Buffer.concat([p1, p2]);
    } finally {
      this.scrubBuffer(key);
    }

  }


  private canonicalAad(policy: SealingPolicy): Buffer {
    // Policy + platform identifiers + deterministic separators.
    // Keep stable to ensure migration determinism.
    const s = `policy=${policy}|cpu=${this.cpuPlatformId}|mrsigner=${this.mrsigner}|mrenclave=${this.mrenclave}`;
    return Buffer.from(s, 'utf8');
  }

  private computeCpuPlatformId(): string {
    return crypto
      .createHash('sha256')
      .update(`cpu-master-root|${this.cpuMasterSecret}`, 'utf8')
      .digest('hex');
  }

  private computeDkSaltHex(policy: SealingPolicy): string {
    const saltInput = `hkdf-salt|policy=${policy}|cpu=${this.cpuMasterSecret}|mrs=${this.mrsigner}|mren=${this.mrenclave}`;
    const salt = crypto.createHash('sha256').update(saltInput, 'utf8').digest();
    return salt.toString('hex');
  }

  private deriveAesKey(policy: SealingPolicy, dkSaltHex: string): Buffer {
    // Simulated hardware roots: cpu master secret + platform identifiers.
    // For MRENCLAVE policy we include MRENCLAVE in the IKM; for MRSIGNER include MRSIGNER.
    const ikm =
      policy === 'MRENCLAVE'
        ? `${this.cpuMasterSecret}|${this.mrsigner}|${this.mrenclave}`
        : `${this.cpuMasterSecret}|${this.mrsigner}`;

    const dk = crypto.hkdfSync(
      'sha256',
      Buffer.from(ikm, 'utf8'),
      Buffer.from(dkSaltHex, 'hex'),
      Buffer.from('enclave-sealing', 'utf8'),
      32
    );
    return Buffer.from(dk as unknown as Uint8Array);

  }

  private computeKeyId(policy: SealingPolicy): string {
    const keyIdInput = `keyid|policy=${policy}|cpu=${this.cpuPlatformId}|mrs=${this.mrsigner}|mren=${this.mrenclave}`;
    return crypto.createHash('sha256').update(keyIdInput, 'utf8').digest('hex');
  }

  private scrubBuffer(buf: Buffer): void {
    try {
      buf.fill(0);
    } catch {
      // ignore
    }
  }
}


