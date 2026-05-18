/*
 * Univer-Escrow — EventStreamService
 *
 * Purpose:
 * - Provide an environment-safe, long-lived server-to-client event streaming dispatcher.
 * - Dispatch only minimal, sanitized escrow status tokens.
 * - Prevent leakage of internal metrics, private partner merchant keys, routing metadata,
 *   and other sensitive processing signals.
 */

export type EscrowStatus = 'PENDING' | 'LOCKED' | 'DISPUTED' | 'RELEASED' | 'REFUNDED';

export type EscrowStatusToken = {
  tenantId: string;
  escrowId: string;
  state: EscrowStatus;
  // Opaque transition id (host-defined). Used for idempotency on the client.
  transitionId: string;
  updatedAt: string;
};

export type StreamClient = {
  // Implemented by host transport (SSE/WebSocket/etc.)
  send: (payload: EscrowStatusToken) => Promise<void> | void;
  close?: (reason?: string) => Promise<void> | void;
};

export type EscrowMutationEvent = {
  tenantId: string;
  escrowId: string;
  // Raw internal state update coming from storage/webhook layer.
  // The service will scrub/normalize before sending.
  state: EscrowStatus;
  transitionId: string;
  updatedAt: string;
  // Potential sensitive fields exist in raw event; they MUST NOT be forwarded.
  [k: string]: unknown;
};

export type Unsubscribe = () => void;

export type EscrowMutationListener = {
  onMutation: (handler: (evt: EscrowMutationEvent) => Promise<void> | void) => Unsubscribe;
};

export type EventStreamServiceConfig = {
  // Host-provided mutation listener for escrow state changes.
  mutationListener: EscrowMutationListener;
};

export class EventStreamService {
  private readonly mutationListener: EscrowMutationListener;
  private unsubscribe?: Unsubscribe;

  private readonly subscribersByKey = new Map<string, Set<StreamClient>>();

  constructor(cfg: EventStreamServiceConfig) {
    if (!cfg?.mutationListener) throw new Error('EventStreamService.mutationListener_REQUIRED');
    this.mutationListener = cfg.mutationListener;
  }

  /**
   * Start listening to escrow mutations.
   * Safe to call once; subsequent calls will no-op.
   */
  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = this.mutationListener.onMutation(async (evt) => {
      const token = this.scrubAndNormalize(evt);
      this.dispatchToken(token);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } finally {
        this.unsubscribe = undefined;
      }
    }
  }

  /**
   * Subscribe a client to a specific tenant+escrow stream.
   * Keying is host-defined; this service never stores secrets.
   */
  async subscribe(tenantId: string, escrowId: string, client: StreamClient): Promise<Unsubscribe> {
    const key = this.subKey(tenantId, escrowId);
    const set = this.subscribersByKey.get(key) ?? new Set<StreamClient>();
    set.add(client);
    this.subscribersByKey.set(key, set);

    return async () => {
      const current = this.subscribersByKey.get(key);
      if (!current) return;
      current.delete(client);
      if (current.size === 0) this.subscribersByKey.delete(key);
      if (client.close) await client.close('unsubscribed');
    };
  }

  private subKey(tenantId: string, escrowId: string): string {
    return `${tenantId}::${escrowId}`;
  }

  /**
   * Scrub/normalize raw mutation events into minimal status tokens.
   *
   * Explicitly drops:
   * - any hidden metrics
   * - any merchant/partner keys
   * - any internal routing parameters
   */
  private scrubAndNormalize(evt: EscrowMutationEvent): EscrowStatusToken {
    // Validate presence; do not forward raw event.
    if (!evt.tenantId || !evt.escrowId) {
      throw new Error('EVENTSTREAM_INVALID_EVENT');
    }

    const token: EscrowStatusToken = {
      tenantId: evt.tenantId,
      escrowId: evt.escrowId,
      state: evt.state,
      transitionId: evt.transitionId,
      updatedAt: evt.updatedAt,
    };

    return token;
  }

  private dispatchToken(token: EscrowStatusToken): void {
    const key = this.subKey(token.tenantId, token.escrowId);
    const targets = this.subscribersByKey.get(key);
    if (!targets || targets.size === 0) return;

    for (const client of targets) {
      // Isolation: errors in a single client must not break dispatch.
      Promise.resolve()
        .then(() => client.send(token))
        .catch(() => {
          // Best-effort: ignore; host can implement its own client cleanup.
        });
    }
  }
}

