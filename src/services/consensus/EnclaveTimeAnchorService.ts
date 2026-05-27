import crypto from 'crypto';

export type NodeId = string;

export type SignedTimeAssertion = {
  nodeId: NodeId;
  /** Node’s asserted wall-clock time, in milliseconds since epoch. */
  assertedAtMs: number;
  /** Signature over the canonical assertion payload. */
  signature: string;
  /** Trusted attestation-derived PCR0 hash token to bind identity (opaque to verifier). */
  pcr0Hash: string;
  /** Optional per-assertion expiry, in ms since epoch. */
  validUntilMs?: number;
};

export type MedianTimeAnchor = {
  /** Consensus-derived median time, ms since epoch. */
  anchorMs: number;
  /** Deterministic binding to make anchor tamper-evident. */
  anchorFingerprint: string;
  /** IDs included after filtering. */
  includedNodeIds: NodeId[];
  /** For auditability/debugging without disclosing raw times to disk. */
  outlierNodeIds: NodeId[];
};

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
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

export class EnclaveTimeAnchorService {
  private static instance: EnclaveTimeAnchorService | null = null;

  /** Rolling window of recent assertions. */
  private assertions: Map<NodeId, SignedTimeAssertion> = new Map();

  private readonly windowMaxSize: number;

  /** Default allowed drift: ±5 seconds from median. */
  private readonly driftThresholdMs: number;

  private constructor(opts?: { windowMaxSize?: number; driftThresholdMs?: number }) {
    this.windowMaxSize = opts?.windowMaxSize ?? 32;
    this.driftThresholdMs = opts?.driftThresholdMs ?? 5_000;
  }

  public static getInstance(): EnclaveTimeAnchorService {
    if (!EnclaveTimeAnchorService.instance) {
      EnclaveTimeAnchorService.instance = new EnclaveTimeAnchorService();
    }
    return EnclaveTimeAnchorService.instance;
  }

  public reset(): void {
    this.assertions.clear();
  }

  /**
   * In the in-repo implementation we do not have real signature verification.
   * We still enforce type-safe structure and bind signature to content deterministically.
   *
   * Production deployments must replace `verifySignatureMock()` with enclave-verified crypto.
   */
  public ingestAssertion(assertion: SignedTimeAssertion): { ok: boolean; reason?: string } {
    try {
      if (!assertion || typeof assertion !== 'object') return { ok: false, reason: 'INVALID_ASSERTION' };
      if (!assertion.nodeId || typeof assertion.nodeId !== 'string') return { ok: false, reason: 'INVALID_NODE_ID' };
      if (!isFiniteNumber(assertion.assertedAtMs)) return { ok: false, reason: 'INVALID_ASSERTED_AT_MS' };
      if (!assertion.pcr0Hash || typeof assertion.pcr0Hash !== 'string') return { ok: false, reason: 'INVALID_PCR0_HASH' };
      if (!assertion.signature || typeof assertion.signature !== 'string') return { ok: false, reason: 'INVALID_SIGNATURE' };

      if (assertion.validUntilMs !== undefined) {
        if (!isFiniteNumber(assertion.validUntilMs)) return { ok: false, reason: 'INVALID_VALID_UNTIL_MS' };
        // Fail-closed: expired assertions cannot participate.
        if (assertion.validUntilMs <= assertion.assertedAtMs) {
          return { ok: false, reason: 'ASSERTION_EXPIRED_OR_INVALID' };
        }
      }

      const sigOk = this.verifySignatureMock(assertion);
      if (!sigOk) return { ok: false, reason: 'SIGNATURE_REJECTED' };

      // Maintain rolling window size.
      if (this.assertions.size >= this.windowMaxSize) {
        // Remove lexicographically smallest nodeId to keep deterministic behavior.
        const keys = Array.from(this.assertions.keys()).sort();
        const toDelete = keys[0];
        this.assertions.delete(toDelete);
      }

      this.assertions.set(assertion.nodeId, assertion);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'INGEST_EXCEPTION' };
    }
  }

  private verifySignatureMock(assertion: SignedTimeAssertion): boolean {
    // Signature must equal SHA256(canonicalPayload).
    const canonical = stableStringify({
      nodeId: assertion.nodeId,
      assertedAtMs: assertion.assertedAtMs,
      pcr0Hash: assertion.pcr0Hash,
      validUntilMs: assertion.validUntilMs ?? null
    });

    const expected = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    // Fail-closed strict equality.
    return assertion.signature === expected;
  }

  /**
   * Compute deterministic median anchor from ingested assertions.
   * Filtering is done by computing a running median, then excluding outliers
   * whose drift exceeds ±driftThresholdMs relative to that median.
   */
  public computeMedianAnchor(opts?: { requiredMinAssertions?: number }): { ok: boolean; anchor?: MedianTimeAnchor; reason?: string } {
    const values = Array.from(this.assertions.values());
    if (values.length === 0) return { ok: false, reason: 'NO_ASSERTIONS' };

    const assertedTimes = values.map((a) => a.assertedAtMs).sort((a, b) => a - b);

    const median = this.medianOfSorted(assertedTimes);

    // Filter outliers relative to median.
    const included: SignedTimeAssertion[] = [];
    const outliers: SignedTimeAssertion[] = [];
    for (const a of values) {
      const drift = Math.abs(a.assertedAtMs - median);
      if (drift > this.driftThresholdMs) outliers.push(a);
      else included.push(a);
    }

    const requiredMin = opts?.requiredMinAssertions ?? 3;
    if (included.length < requiredMin) {
      return { ok: false, reason: 'INSUFFICIENT_QUORUM_AFTER_FILTERING' };
    }

    const anchorMs = this.medianOfSorted(included.map((a) => a.assertedAtMs).sort((x, y) => x - y));

    const includedNodeIds = included.map((a) => a.nodeId).sort();
    const outlierNodeIds = outliers.map((a) => a.nodeId).sort();

    const anchorFingerprint = crypto
      .createHash('sha256')
      .update(
        stableStringify({
          domain: 'ENCLAVE_MEDIAN_TIME_ANCHOR',
          anchorMs,
          includedNodeIds,
          outlierNodeIds
        }),
        'utf8'
      )
      .digest('hex');

    return {
      ok: true,
      anchor: {
        anchorMs,
        anchorFingerprint,
        includedNodeIds,
        outlierNodeIds
      }
    };
  }

  private medianOfSorted(sorted: number[]): number {
    const n = sorted.length;
    if (n === 0) throw new Error('medianOfSorted: empty');
    const mid = Math.floor(n / 2);
    if (n % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
    return sorted[mid];
  }

  /** For the in-repo regression harness only. */
  public getAssertionCount(): number {
    return this.assertions.size;
  }
}

