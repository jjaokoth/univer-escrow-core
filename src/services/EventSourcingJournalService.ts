/******************************************************
 * EventSourcingJournalService.ts
 * ----------------------------------------------------
 * Tenant-scoped in-memory append-only journal.
 ******************************************************/

import { createHash } from 'crypto';

export type JournalEventPayload = Record<string, unknown>;

export type JournalEvent = {
  tenantId: string;
  transactionId: string;
  payload: JournalEventPayload;
  /** Monotonic sequence within tenant journal (in-memory). */
  seq: number;
  /** Integrity hash bound to event contents. */
  signatureHex: string;
  enqueuedAt: number;
};

export interface EventJournalPersistence {
  persistJournalBatch(events: JournalEvent[]): Promise<void>;
}

export interface EventSourcingJournalServiceOptions {
  persistence: EventJournalPersistence;
  /** Max buffered events per tenant before micro-batching. */
  maxBufferedEvents?: number;
  /** How often to flush when there is buffered work. */
  flushIntervalMs?: number;
}

function computeSignatureHex(input: {
  tenantId: string;
  transactionId: string;
  payload: JournalEventPayload;
}): string {
  const canonical = JSON.stringify({
    tenantId: input.tenantId,
    transactionId: input.transactionId,
    payload: input.payload,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class EventSourcingJournalService {
  private readonly persistence: EventJournalPersistence;
  private readonly maxBufferedEvents: number;
  private readonly flushIntervalMs: number;

  /** tenantId -> events (append-only). */
  private readonly journals = new Map<string, JournalEvent[]>();

  /** tenantId -> next sequence. */
  private readonly seqByTenant = new Map<string, number>();

  private flushTimer?: NodeJS.Timeout;
  private flushing = false;

  constructor(options: EventSourcingJournalServiceOptions) {
    this.persistence = options.persistence;
    this.maxBufferedEvents = options.maxBufferedEvents ?? 5000;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
  }

  public startFlushJournalToPersistenceLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flushJournalToPersistence();
    }, this.flushIntervalMs);
  }

  public stopFlushJournalToPersistenceLoop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * Hot ingest path: append-only, tenant-isolated, no DB blocking.
   * Returns an immediate success token.
   */
  public journalTransactionEvent(params: {
    tenantId: string;
    transactionId: string;
    payload: JournalEventPayload;
  }): { ok: true; token: string; seq: number } {
    const { tenantId, transactionId, payload } = params;

    if (!tenantId || !transactionId) {
      throw new Error('Missing tenantId or transactionId');
    }
    if (payload == null || typeof payload !== 'object') {
      throw new Error('Invalid payload');
    }

    const nextSeq = (this.seqByTenant.get(tenantId) ?? 0) + 1;
    this.seqByTenant.set(tenantId, nextSeq);

    const signatureHex = computeSignatureHex({ tenantId, transactionId, payload });

    const event: JournalEvent = {
      tenantId,
      transactionId,
      payload,
      seq: nextSeq,
      signatureHex,
      enqueuedAt: Date.now(),
    };

    const queue = this.journals.get(tenantId) ?? [];
    if (queue.length >= this.maxBufferedEvents) {
      // In hot ingest, we fail fast to avoid memory exhaustion.
      throw new Error(`Journal buffer overflow for tenant=${tenantId}`);
    }
    queue.push(event);
    this.journals.set(tenantId, queue);

    const token = `evt:${tenantId}:${transactionId}:${signatureHex.slice(0, 16)}:${nextSeq}`;
    return { ok: true, token, seq: nextSeq };
  }

  private async flushJournalToPersistence(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      const tenantIds = Array.from(this.journals.keys());
      if (tenantIds.length === 0) return;

      // Parallel micro-batches per tenant.
      await Promise.all(
        tenantIds.map(async (tenantId) => {
          const queue = this.journals.get(tenantId);
          if (!queue || queue.length === 0) return;

          // Micro-batch size: keep small to bound latency.
          const batchSize = Math.min(200, queue.length);
          const batch = queue.splice(0, batchSize);
          if (batch.length === 0) return;

          await this.persistence.persistJournalBatch(batch);
        }),
      );
    } finally {
      this.flushing = false;
    }
  }
}

