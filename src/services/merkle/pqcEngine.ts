import crypto from 'crypto';

export type HexLike = string & { readonly __brand: 'HexLike' };

export type MLDSAPublicKey = {
  /**
   * Dedicated token format to mimic a structured lattice key.
   * Example: "MLDSA-PUB:idx=1;seed=<hex>;params=k=2,l=2".
   */
  token: string;
  idx: number;
  seedHex: HexLike;
  k: number;
  l: number;
};

export type PQCVerificationResult = {
  ok: boolean;
  /** scrub test visibility; non-production */
  scrubbedBytes: number;
};

function scrub(buf: Buffer): void {
  buf.fill(0);
}

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0;
}

function parseHexLike(s: string): HexLike | null {
  if (!isHex(s)) return null;
  return s as HexLike;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Strictly parses a dedicated mock ML-DSA public key token.
 */
export function parseMLDSAPublicKey(token: string): MLDSAPublicKey | null {
  if (!token || typeof token !== 'string') return null;

  // Expected shape: MLDSA-PUB:idx=<n>;seed=<hex>;params=k=<n>,l=<n>
  const trimmed = token.trim();
  if (!trimmed.startsWith('MLDSA-PUB:')) return null;

  const body = trimmed.slice('MLDSA-PUB:'.length);
  const parts = body.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  let idx: number | null = null;
  let seedHex: HexLike | null = null;
  let k: number | null = null;
  let l: number | null = null;

  for (const p of parts) {
    if (p.startsWith('idx=')) {
      const v = Number(p.slice('idx='.length));
      if (!Number.isInteger(v) || v < 0 || v > 1_000_000) return null;
      idx = v;
      continue;
    }
    if (p.startsWith('seed=')) {
      const h = p.slice('seed='.length);
      const parsed = parseHexLike(h);
      if (!parsed) return null;
      seedHex = parsed;
      continue;
    }
    if (p.startsWith('params=')) {
      const params = p.slice('params='.length);
      const kv = params.split(',').map((x) => x.trim()).filter(Boolean);
      const kPart = kv.find((x) => x.startsWith('k='));
      const lPart = kv.find((x) => x.startsWith('l='));
      if (!kPart || !lPart) return null;
      const kVal = Number(kPart.slice('k='.length));
      const lVal = Number(lPart.slice('l='.length));
      if (!Number.isInteger(kVal) || !Number.isInteger(lVal)) return null;
      if (kVal <= 0 || lVal <= 0 || kVal > 8 || lVal > 8) return null;
      k = kVal;
      l = lVal;
      continue;
    }

    return null;
  }

  if (idx === null || !seedHex || k === null || l === null) return null;

  return {
    token: trimmed,
    idx,
    seedHex,
    k,
    l
  };
}

/**
 * Mock ML-DSA (lattice-based) verification.
 * - Ingests a structured lattice public key token.
 * - Computes a polynomial-style validation matrix derived from message hash.
 * - Compares against a structured pqcSignature token deterministically.
 * - Scrubs transient buffers post-evaluation.
 */
export function verifyMockMLDSA(params: {
  message: string;
  messageHashHex: HexLike;
  pqcSignature: string;
  publicKey: MLDSAPublicKey;
}): PQCVerificationResult {
  const { messageHashHex, pqcSignature, publicKey } = params;

  // Transient buffers for scrub accounting.
  const scrubbedParts: Buffer[] = [];
  const pushBuf = (b: Buffer) => {
    scrubbedParts.push(b);
    return b;
  };

  try {
    // Signature token format (dedicated, structured):
    // "MLDSA-SIG:idx=<n>;sig=<hex>"
    if (!pqcSignature || typeof pqcSignature !== 'string') {
      return { ok: false, scrubbedBytes: 0 };
    }
    const trimmed = pqcSignature.trim();
    if (!trimmed.startsWith('MLDSA-SIG:')) {
      return { ok: false, scrubbedBytes: 0 };
    }

    const body = trimmed.slice('MLDSA-SIG:'.length);
    const parts = body.split(';').map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) return { ok: false, scrubbedBytes: 0 };

    let sigIdx: number | null = null;
    let sigHex: HexLike | null = null;

    for (const p of parts) {
      if (p.startsWith('idx=')) {
        const v = Number(p.slice('idx='.length));
        if (!Number.isInteger(v) || v < 0 || v > 1_000_000) return { ok: false, scrubbedBytes: 0 };
        sigIdx = v;
        continue;
      }
      if (p.startsWith('sig=')) {
        const h = p.slice('sig='.length);
        const parsed = parseHexLike(h);
        if (!parsed) return { ok: false, scrubbedBytes: 0 };
        sigHex = parsed;
        continue;
      }
      return { ok: false, scrubbedBytes: 0 };
    }

    if (sigIdx === null || !sigHex) return { ok: false, scrubbedBytes: 0 };

    // Strict lattice-key index match.
    if (sigIdx !== publicKey.idx) return { ok: false, scrubbedBytes: 0 };

    // Polynomial-style validation matrix:
    // For i in [0,k), j in [0,l), compute coeff = H^((i+1)*(j+1)) mod 256 and pack into bytes.
    // Then compute a commitment = SHA256(matrixBytes || messageHashBytes) and compare to sigHex.
    const messageHashBytes = pushBuf(Buffer.from(messageHashHex, 'hex'));

    // Build matrix bytes (transient).
    const matrixSize = publicKey.k * publicKey.l;
    const matrixBytes = Buffer.allocUnsafe(matrixSize);
    for (let i = 0; i < publicKey.k; i++) {
      for (let j = 0; j < publicKey.l; j++) {
        const exp = (i + 1) * (j + 1);
        // Use repeated squaring in the exponent space over bytes (mocked):
        // coeffByte = (messageHashBytes[ (exp-1) % len ] + exp) mod 256.
        const idx = (exp - 1) % messageHashBytes.length;
        const coeff = (messageHashBytes[idx] + exp) & 0xff;
        matrixBytes[i * publicKey.l + j] = coeff;
      }
    }
    const matrixBuf = pushBuf(matrixBytes);

    const commitmentInput = Buffer.concat([
      matrixBuf,
      messageHashBytes,
      Buffer.from(publicKey.seedHex, 'hex')
    ]);
    const commitmentHash = crypto.createHash('sha256').update(commitmentInput).digest();
    const commitmentHashBuf = pushBuf(Buffer.from(commitmentHash));

    const expectedSigBytes = Buffer.from(sigHex, 'hex');
    if (expectedSigBytes.length !== commitmentHashBuf.length) {
      // Fail closed.
      return { ok: false, scrubbedBytes: 0 };
    }

    const ok = constantTimeEqual(commitmentHashBuf, expectedSigBytes);
    const scrubbedBytes = scrubbedParts.reduce((acc, b) => acc + b.length, 0);

    // Scrub transient buffers.
    for (const b of scrubbedParts) scrub(b);

    return { ok, scrubbedBytes };
  } catch {
    // Best-effort scrub on error.
    for (const b of scrubbedParts) {
      try {
        scrub(b);
      } catch {
        // ignore
      }
    }
    const scrubbedBytes = scrubbedParts.reduce((acc, b) => acc + b.length, 0);
    return { ok: false, scrubbedBytes };
  }
}

export function hexSha256Hex(input: string): HexLike {
  const h = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  return h as HexLike;
}

