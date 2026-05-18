/**
 * © 2026 Securerise Solutions Limited
 * NotificationRetryWorker
 *
 * Purpose:
 * - Monitor failed delivery tasks and retry using exponential backoff.
 * - Cap retries at exactly 5 attempts.
 * - After final failure, migrate to a dead-letter-queue classification via host callback.
 */

export type NotificationRetryWorkerConfig = {
  dispatcher: {
    drainDueFailures: (nowMs?: number, limit?: number) => Array<{
      tenantId: string;
      eventType: string;
      payload: unknown;
      targetUrl: string;
      attempt: number;
      lastStatus: number;
      signature: string;
      nextAttemptAtMs: number;
      lastBodyText?: string;
    }>;
    sendSigned: (args: {
      tenantId: string;
      eventType: string;
      payload: unknown;
      targetUrl: string;
      signature: string;
    }) => Promise<{ status: number; bodyText?: string }>;
    requeueFailure: (record: {
      tenantId: string;
      eventType: string;
      payload: unknown;
      targetUrl: string;
      attempt: number;
      lastStatus: number;
      signature: string;
      nextAttemptAtMs: number;
      lastBodyText?: string;
    }) => void;
    cleanupExpired?: (tenantId: string, eventType: string) => Promise<void>;
  };

  /** base backoff in milliseconds */
  baseWaitMs?: number;

  /** Poll interval for the retry loop */
  pollIntervalMs?: number;

  /** Host-provided DLQ handler */
  onExpired: (args: {
    tenantId: string;
    eventType: string;
    payload: unknown;
    targetUrl: string;
    lastStatus: number;
    signature: string;
    attempts: number;
  }) => Promise<void> | void;

  /** Structural trace logger */
  logDeliveryExpired?: (args: {
    tenantId: string;
    eventType: string;
    trace: { attempts: number; lastStatus: number };
  }) => void;
};

type FailedRecord = {
  tenantId: string;
  eventType: string;
  payload: unknown;
  targetUrl: string;
  attempt: number;
  lastStatus: number;
  signature: string;
  nextAttemptAtMs: number;
  lastBodyText?: string;
};

export class NotificationRetryWorker {
  private readonly dispatcher: NotificationRetryWorkerConfig['dispatcher'];
  private readonly baseWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly onExpired: NotificationRetryWorkerConfig['onExpired'];
  private readonly logDeliveryExpired?: NotificationRetryWorkerConfig['logDeliveryExpired'];

  private timer?: ReturnType<typeof setInterval>;

  private running = false;

  // retry cap: exactly 5 attempts maximum.
  // Meaning: attempt index 0..4 are retries, when attempt becomes 5 => expired.
  private readonly maxAttempts = 5;

  constructor(cfg: NotificationRetryWorkerConfig) {
    if (!cfg?.dispatcher) throw new Error('NotificationRetryWorker.dispatcher_REQUIRED');
    if (!cfg?.onExpired) throw new Error('NotificationRetryWorker.onExpired_REQUIRED');

    this.dispatcher = cfg.dispatcher;
    this.baseWaitMs = cfg.baseWaitMs ?? 500;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 750;
    this.onExpired = cfg.onExpired;
    this.logDeliveryExpired = cfg.logDeliveryExpired;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = Date.now();
      const due = this.dispatcher.drainDueFailures(now, 2000) as FailedRecord[];

      for (const rec of due) {
        await this.handleFailure(rec);
      }
    } finally {
      this.running = false;
    }
  }

  private calcWaitMs(attempt: number): number {
    // wait = base * 2^attempt
    const p = Math.max(0, Math.floor(attempt));
    // prevent overflow: cap exponent growth practically
    const pow = p > 30 ? 2 ** 30 : 2 ** p;
    return this.baseWaitMs * pow;
  }

  private async handleFailure(rec: FailedRecord): Promise<void> {
    // Attempt counter semantics: rec.attempt is current attempt index.
    // When attempt >= maxAttempts, move to DLQ.
    if (rec.attempt >= this.maxAttempts) {
      await this.expire(rec);
      return;
    }

    const res = await this.dispatcher.sendSigned({
      tenantId: rec.tenantId,
      eventType: rec.eventType,
      payload: rec.payload,
      targetUrl: rec.targetUrl,
      signature: rec.signature,
    });

    if (res.status === 200) {
      // Delivery succeeded; do nothing.
      return;
    }

    const nextAttempt = rec.attempt + 1;

    if (nextAttempt >= this.maxAttempts) {
      // After scheduling past the final threshold, expire.
      await this.expire({ ...rec, attempt: nextAttempt, lastStatus: res.status, lastBodyText: res.bodyText });
      return;
    }

    const waitMs = this.calcWaitMs(nextAttempt);
    this.dispatcher.requeueFailure({
      tenantId: rec.tenantId,
      eventType: rec.eventType,
      payload: rec.payload,
      targetUrl: rec.targetUrl,
      attempt: nextAttempt,
      lastStatus: res.status,
      signature: rec.signature,
      nextAttemptAtMs: Date.now() + waitMs,
      lastBodyText: res.bodyText,
    });
  }

  private async expire(rec: FailedRecord & { attempt: number; lastStatus: number }): Promise<void> {
    const attempts = rec.attempt;

    if (this.logDeliveryExpired) {
      this.logDeliveryExpired({
        tenantId: rec.tenantId,
        eventType: rec.eventType,
        trace: { attempts, lastStatus: rec.lastStatus },
      });
    } else {
      // Default structural trace.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          metric: 'DELIVERY_EXPIRED',
          tenantId: rec.tenantId,
          eventType: rec.eventType,
          trace: { attempts, lastStatus: rec.lastStatus },
        })
      );
    }

    await this.onExpired({
      tenantId: rec.tenantId,
      eventType: rec.eventType,
      payload: rec.payload,
      targetUrl: rec.targetUrl,
      lastStatus: rec.lastStatus,
      signature: rec.signature,
      attempts,
    });

    if (this.dispatcher.cleanupExpired) {
      await this.dispatcher.cleanupExpired(rec.tenantId, rec.eventType);
    }
  }
}

