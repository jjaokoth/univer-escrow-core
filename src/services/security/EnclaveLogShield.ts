import crypto from 'crypto';

export type RedactedToken = string;

export type EnclaveRingBufferEntry = {
  trackingId: string;
  ts: string;
  cleartext: unknown;
};

const DEFAULT_RING_BUFFER_CAPACITY = 64;

/**
 * EnclaveLogShield
 *
 * Confidential runtime log sanitation and redacted-telemetry mapping.
 * - All redaction mappings are deterministic but non-reversible.
 * - Cleartext is never written to filesystem/cloud by this module.
 * - Cleartext is stored only transiently in an in-memory ring buffer
 *   for enclave-only diagnostics channels.
 */
export class EnclaveLogShield {
  private static enclaveSalt: string = process.env.ENCLAVE_LOG_SHIELD_SALT ?? 'inrepo-enclave-salt';
  private static ringBuffer: EnclaveRingBufferEntry[] = [];
  private static ringBufferCapacity: number = Number(process.env.ENCLAVE_LOG_SHIELD_RING_CAPACITY ?? DEFAULT_RING_BUFFER_CAPACITY);

  /** Cleartext diagnostic sink (enclave-only). */
  public static putCleartext(trackingId: string, cleartext: unknown): void {
    const entry: EnclaveRingBufferEntry = {
      trackingId,
      ts: new Date().toISOString(),
      cleartext
    };

    EnclaveLogShield.ringBuffer.push(entry);
    if (EnclaveLogShield.ringBuffer.length > EnclaveLogShield.ringBufferCapacity) {
      EnclaveLogShield.ringBuffer.shift();
    }
  }

  /**
   * Test-only accessor: verifies cleartext never escapes enclave boundary.
   * Production code must not call this.
   */
  public static __testGetCleartextByTrackingId(trackingId: string): EnclaveRingBufferEntry | null {
    const found = EnclaveLogShield.ringBuffer.find((e) => e.trackingId === trackingId) ?? null;
    return found;
  }

  public static __testClearRingBuffer(): void {
    EnclaveLogShield.ringBuffer = [];
  }

  public static computeRedactedToken(sensitiveValue: string, enclaveSalt: string = EnclaveLogShield.enclaveSalt): RedactedToken {
    // RedactedToken = SHA256(SensitiveValue || EnclaveSalt)
    const input = `${sensitiveValue}||${enclaveSalt}`;
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  private static isLikelySensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    return (
      k === 'commitment' ||
      k === 'transactionid' ||
      k === 'transaction_id' ||
      k === 'transactionid' ||
      k === 'signature' ||
      k === 'publickey' ||
      k.endsWith('signature') ||
      k.includes('commitment') ||
      k.includes('transaction')
    );
  }

  private static redactString(s: string): string {
    // Strict boundary regexes with safe fallbacks.
    // We redact common patterns for: commitment=..., transactionId=..., signature=...
    const patterns: Array<{ re: RegExp; label: 'commitment' | 'transactionId' | 'signature' }> = [
      { re: /\bcommitment\b\s*[:=]\s*([^\s,;]+)/gi, label: 'commitment' },
      { re: /\btransactionId\b\s*[:=]\s*([^\s,;]+)/gi, label: 'transactionId' },
      { re: /\btransaction_id\b\s*[:=]\s*([^\s,;]+)/gi, label: 'transactionId' },
      { re: /\bsignature\b\s*[:=]\s*([^\s,;]+)/gi, label: 'signature' }
    ];

    let out = s;
    for (const p of patterns) {
      out = out.replace(p.re, (match: string, value: string) => {
        const token = EnclaveLogShield.computeRedactedToken(String(value));
        // Deterministic token mapping; non-reversible.
        return `${p.label}=[REDACTED_${token}]`;
      });
    }

    return out;
  }

  /** Recursively sanitizes values and scrubs stack traces. */
  public static sanitizeAny(input: unknown): unknown {
    if (typeof input === 'string') {
      // Redact any embedded sensitive markers.
      return EnclaveLogShield.redactString(input);
    }

    if (Buffer.isBuffer(input)) {
      // Never expose raw buffers.
      const token = EnclaveLogShield.computeRedactedToken(input.toString('hex'));
      return `[BUFFER_REDACTED_${token}]`;
    }

    if (Array.isArray(input)) {
      return input.map((v) => EnclaveLogShield.sanitizeAny(v));
    }

    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (EnclaveLogShield.isLikelySensitiveKey(k)) {
          if (typeof v === 'string') {
            const token = EnclaveLogShield.computeRedactedToken(v);
            out[k] = `[REDACTED_${token}]`;
          } else {
            // Drop non-string sensitive-ish values.
            out[k] = '[REDACTED_NONSTRING]';
          }
          continue;
        }

        // Scrub stack traces explicitly.
        if (k.toLowerCase() === 'stack' && typeof v === 'string') {
          out[k] = '[STACK_REDACTED]';
          continue;
        }

        out[k] = EnclaveLogShield.sanitizeAny(v);
      }
      return out;
    }

    return input;
  }

  public static sanitizeError(error: unknown): {
    trackingId: string;
    message: string;
    safe: unknown;
  } {
    const trackingId = crypto.randomUUID();

    if (!(error instanceof Error)) {
      const safe = EnclaveLogShield.sanitizeAny(error);
      return {
        trackingId,
        message: 'INTERNAL_ERROR',
        safe
      };
    }

    const safeObj = {
      name: error.name,
      message: EnclaveLogShield.redactString(error.message ?? ''),
      stack: '[STACK_REDACTED]'
    };

    const details = EnclaveLogShield.sanitizeAny((error as any).details ?? (error as any).payload ?? undefined);

    return {
      trackingId,
      message: 'INTERNAL_ERROR',
      safe: {
        ...safeObj,
        details
      }
    };
  }
}

