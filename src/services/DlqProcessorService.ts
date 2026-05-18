/*
 * Univer-Escrow — DlqProcessorService
 *
 * Purpose:
 * - Process corrupted, unverified, or timed-out webhook notifications.
 * - Isolate potentially malicious payloads into a DLQ pool:
 *   /tenants/{tenantId}/dlq_records/{dlqRecordId}
 * - Provide safe re-verification workflows for delayed transactions
 *   without mutating immutable primary transaction state.
 */

export type DlqReason =
  | 'SIGNATURE_VERIFICATION_FAILED'
  | 'PAYLOAD_STRUCTURAL_ERROR'
  | 'WEBHOOK_TIMEOUT'
  | 'INTEGRITY_MISMATCH'
  | 'UNKNOWN_ERROR';

export type DlqRecord = {
  tenantId: string;
  dlqRecordId: string;
  escrowId?: string;
  traceToken: string;
  reason: DlqReason;
  // Store raw payload safely; host should ensure content-size limits.
  rawPayload: unknown;
  createdAt: string;
  // Optional admin correlation
  sourceProvider?: string;
};

export type DlqRetryPlan = {
  traceToken: string;
  escrowId?: string;
  // Host-defined re-verification inputs.
  // For example: recompute integrity signature or re-fetch provider verification.
  retryContext?: Record<string, unknown>;
};

export type DlqDataAdapter = {
  // Store DLQ record (isolated collection) — no primary mutation.
  createDlqRecord: (record: DlqRecord) => Promise<void>;

  // Fetch DLQ record
  getDlqRecord: (args: { tenantId: string; dlqRecordId: string }) => Promise<DlqRecord | null>;

  // Host-defined integrity re-check (returns ok)
  reverifyPayload: (args: {
    tenantId: string;
    escrowId?: string;
    rawPayload: unknown;
    retryContext?: Record<string, unknown>;
  }) => Promise<{ ok: boolean; reason?: string }>;

  // Optionally create an admin-visible audit marker for successful retries.
  markDlqRetryResult: (args: {
    tenantId: string;
    dlqRecordId: string;
    ok: boolean;
    reason?: string;
  }) => Promise<void>;

  // Optional: keep immutable primary state unchanged. If host wants a follow-up,
  // it can create a new escrow mutation request rather than altering active immutable rows.
};

export type DlqProcessorConfig = {
  adapter: DlqDataAdapter;
  // Content guard
  maxPayloadChars?: number;
};

function newTraceToken(): string {
  // Trace token should be non-guessable; host may replace with stronger RNG.
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `dlq_${now}_${rand}`;
}

function safePayloadPreview(payload: unknown, maxChars: number): unknown {
  // Avoid logging secrets; truncate stringified payload for storage if needed.
  // We do not mutate rawPayload here; host adapter decides how to store.
  try {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (s.length <= maxChars) return payload;
    return { __truncated: true, length: s.length, preview: s.slice(0, maxChars) };
  } catch {
    return { __unserializable: true };
  }
}

export class DlqProcessorService {
  private readonly adapter: DlqDataAdapter;
  private readonly maxPayloadChars: number;

  constructor(cfg: DlqProcessorConfig) {
    if (!cfg?.adapter) throw new Error('DlqProcessorService.adapter_REQUIRED');
    this.adapter = cfg.adapter;
    this.maxPayloadChars = cfg.maxPayloadChars ?? 20_000;
  }

  /**
   * Capture a failed or suspicious webhook payload into isolated DLQ storage.
   */
  async captureFailedWebhook(args: {
    tenantId: string;
    dlqRecordId: string;
    escrowId?: string;
    reason: DlqReason;
    rawPayload: unknown;
    sourceProvider?: string;
  }): Promise<{ traceToken: string }> {
    const traceToken = newTraceToken();

    const record: DlqRecord = {
      tenantId: args.tenantId,
      dlqRecordId: args.dlqRecordId,
      escrowId: args.escrowId,
      traceToken,
      reason: args.reason,
      rawPayload: safePayloadPreview(args.rawPayload, this.maxPayloadChars),
      createdAt: new Date().toISOString(),
      sourceProvider: args.sourceProvider,
    };

    await this.adapter.createDlqRecord(record);
    return { traceToken };
  }

  /**
   * Admin-driven retry: re-verify delayed payloads safely.
   * - Does not mutate immutable state of active escrows.
   */
  async retryDlqRecord(args: {
    tenantId: string;
    dlqRecordId: string;
    plan: DlqRetryPlan;
  }): Promise<{ ok: boolean; reason?: string }> {
    const record = await this.adapter.getDlqRecord({
      tenantId: args.tenantId,
      dlqRecordId: args.dlqRecordId,
    });

    if (!record) {
      return { ok: false, reason: 'DLQ_RECORD_NOT_FOUND' };
    }

    const verification = await this.adapter.reverifyPayload({
      tenantId: args.tenantId,
      escrowId: record.escrowId,
      rawPayload: record.rawPayload,
      retryContext: args.plan.retryContext,
    });

    await this.adapter.markDlqRetryResult({
      tenantId: args.tenantId,
      dlqRecordId: args.dlqRecordId,
      ok: verification.ok,
      reason: verification.reason,
    });

    return verification;
  }
}

