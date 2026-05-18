/**
 * © 2026 Securerise Solutions Limited
 * NotificationDispatcherService
 *
 * Purpose:
 * - Format and sign outbound tenant webhook notifications.
 * - Dispatch delivery tasks to a non-blocking execution pool.
 *
 * Design constraints:
 * - Tenant formatting runs inside a per-dispatch tenant scope to avoid
 *   cross-tenant exposure of webhook signing configuration.
 * - Cryptographic signing uses HMAC-SHA-256.
 * - The signing header is attached as: X-Univer-Signature.
 */

declare function require(moduleName: string): any;
const { createHmac } = require('crypto');








export type NotificationDispatcherConfig = {
  /** Maximum concurrent outbound deliveries in the local process. */
  maxConcurrency?: number;
  /** Base HMAC algorithm. */
  hmacAlgorithm?: string;
  /** Tenant-specific signing key provider. */
  signingKeyResolver: (tenantId: string) => Promise<string>;
  /** HTTP transport adapter. */
  httpPostJson: (args: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
    timeoutMs?: number;
  }) => Promise<{ status: number; bodyText?: string }>;
  /** Request timeout for outbound deliveries. */
  timeoutMs?: number;
  /** Optional cleanup callback for expired tasks (host-defined). */
  onDeliveryCleanup?: (args: { tenantId: string; eventType: string }) => Promise<void> | void;
};

export type DispatchNotificationArgs<TPayload = unknown> = {
  tenantId: string;
  eventType: string;
  payload: TPayload;
  targetUrl: string;
};

type DispatchTask = {
  args: DispatchNotificationArgs;
  /** signature header */
  signature: string;
};

/**
 * Minimal in-process thread-pool.
 * Node is single-threaded, but we can implement non-blocking concurrency
 * via an internal work queue + in-flight counter.
 */
class AsyncWorkPool {
  private readonly maxConcurrency: number;
  private readonly queue: DispatchTask[] = [];
  private inFlight = 0;
  private readonly worker: (task: DispatchTask) => Promise<void>;

  constructor(maxConcurrency: number, worker: (task: DispatchTask) => Promise<void>) {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    this.worker = worker;
  }

  enqueue(task: DispatchTask) {
    this.queue.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.inFlight < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.inFlight++;
      void this.worker(task)
        .catch(() => {
          // Worker errors are handled by the worker. This pool keeps running.
        })
        .finally(() => {
          this.inFlight--;
          void this.drain();
        });
    }
  }
}

export class NotificationDispatcherService {
  private readonly signingKeyResolver: NotificationDispatcherConfig['signingKeyResolver'];
  private readonly httpPostJson: NotificationDispatcherConfig['httpPostJson'];
  private readonly timeoutMs: number;
  private readonly onDeliveryCleanup?: NotificationDispatcherConfig['onDeliveryCleanup'];
  private readonly hmacAlgorithm: string;

  private readonly pool: AsyncWorkPool;

  /**
   * Local queue of failed deliveries.
   * The retry worker can consume this queue.
   */
  private readonly failedDeliveries: Array<{
    tenantId: string;
    eventType: string;
    payload: unknown;
    targetUrl: string;
    attempt: number;
    lastStatus: number;
    signature: string;
    nextAttemptAtMs: number;
    lastBodyText?: string;
  }> = [];

  constructor(cfg: NotificationDispatcherConfig) {
    if (!cfg?.signingKeyResolver) throw new Error('NotificationDispatcherService.signingKeyResolver_REQUIRED');
    if (!cfg?.httpPostJson) throw new Error('NotificationDispatcherService.httpPostJson_REQUIRED');

    this.signingKeyResolver = cfg.signingKeyResolver;
    this.httpPostJson = cfg.httpPostJson;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.onDeliveryCleanup = cfg.onDeliveryCleanup;
    this.hmacAlgorithm = cfg.hmacAlgorithm ?? 'sha256';

    this.pool = new AsyncWorkPool(cfg.maxConcurrency ?? 10, async (task) => {
      const { args, signature } = task;

      const body = {
        eventType: args.eventType,
        payload: args.payload,
        // Keep metadata minimal; host can extend if needed.
        tenantId: args.tenantId,
        dispatchedAt: new Date().toISOString(),
      };

      // Tenant isolation: signature is computed for this task's tenant only.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Univer-Signature': signature,
        'X-Univer-Event-Type': args.eventType,
      };

      const res = await this.httpPostJson({
        url: args.targetUrl,
        headers,
        body,
        timeoutMs: this.timeoutMs,
      });

      if (res.status !== 200) {
        this.failedDeliveries.push({
          tenantId: args.tenantId,
          eventType: args.eventType,
          payload: args.payload,
          targetUrl: args.targetUrl,
          attempt: 0,
          lastStatus: res.status,
          signature,
          nextAttemptAtMs: Date.now(),
          lastBodyText: res.bodyText,
        });
      }
    });
  }

  /**
   * Public API: thread-safe, non-blocking notification dispatch.
   */
  dispatchNotification<TPayload = unknown>(
    tenantId: string,
    eventType: string,
    payload: TPayload,
    targetUrl: string
  ): void {
    if (!tenantId.trim()) throw new Error('dispatchNotification.tenantId_REQUIRED');
    if (!eventType.trim()) throw new Error('dispatchNotification.eventType_REQUIRED');
    if (!targetUrl.trim()) throw new Error('dispatchNotification.targetUrl_REQUIRED');

    // Tenant-specific formatting/signing in this dispatch call.
    void this.signAndEnqueue({ tenantId, eventType, payload, targetUrl });
  }

  private async signAndEnqueue(args: DispatchNotificationArgs): Promise<void> {
    // Tenant isolation boundary: resolve signing key only for this tenant.
    const signingKey = await this.signingKeyResolver(args.tenantId);

    // Signature input uses a canonical JSON payload.
    // If host changes body shape, signature verification contract must match.
    const canonical = JSON.stringify({
      tenantId: args.tenantId,
      eventType: args.eventType,
      payload: args.payload,
    });

    const signature = createHmac(this.hmacAlgorithm, signingKey)
      .update(canonical, 'utf8')
      .digest('hex');

    this.pool.enqueue({
      args,
      signature,
    });
  }

  /**
   * Consume failed deliveries for retry.
   * Used by NotificationRetryWorker.
   */
  drainDueFailures(nowMs = Date.now(), limit = 1000) {
    const due: typeof this.failedDeliveries = [];
    let i = 0;

    while (i < this.failedDeliveries.length && due.length < limit) {
      const rec = this.failedDeliveries[i];
      if (rec.nextAttemptAtMs <= nowMs) {
        due.push(rec);
        this.failedDeliveries.splice(i, 1);
      } else {
        i++;
      }
    }

    return due;
  }

  /**
   * Re-enqueue a retry record (after recomputing signature if needed).
   */
  requeueFailure(record: {
    tenantId: string;
    eventType: string;
    payload: unknown;
    targetUrl: string;
    attempt: number;
    lastStatus: number;
    signature: string;
    nextAttemptAtMs: number;
    lastBodyText?: string;
  }) {
    this.failedDeliveries.push(record);
  }

  /**
   * Helper for the worker: re-send a signed payload.
   */
  async sendSigned(args: {
    tenantId: string;
    eventType: string;
    payload: unknown;
    targetUrl: string;
    signature: string;
  }): Promise<{ status: number; bodyText?: string }> {
    const body = {
      eventType: args.eventType,
      payload: args.payload,
      tenantId: args.tenantId,
      dispatchedAt: new Date().toISOString(),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Univer-Signature': args.signature,
      'X-Univer-Event-Type': args.eventType,
    };

    return this.httpPostJson({
      url: args.targetUrl,
      headers,
      body,
      timeoutMs: this.timeoutMs,
    });
  }

  async cleanupExpired(tenantId: string, eventType: string) {
    if (!this.onDeliveryCleanup) return;
    await this.onDeliveryCleanup({ tenantId, eventType });
  }
}

