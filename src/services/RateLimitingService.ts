/**
 * © 2026 Securerise Solutions Limited
 * RateLimitingService — in-memory multi-tenant sliding-window limiter.
 *
 * Design:
 * - Per (tenantId, clientKey) key buckets of timestamps over a sliding 60s window.
 * - Memory bounded by dropping timestamps older than the current window.
 * - Deterministic ordering: oldest timestamps are discarded first.
 */

export type RateLimitKey = {
  tenantId: string;
  clientKey: string;
};

type KeyState = {
  timestampsMs: number[];
};

export type RateLimitingServiceConfig = {
  /** Sliding window size (default: 60s). */
  windowMs?: number;
  /** Maximum timestamps retained per key (soft bound; default: 10000). */
  maxTimestampsPerKey?: number;
};

export class RateLimitingService {
  private readonly windowMs: number;
  private readonly maxTimestampsPerKey: number;

  // rate::[tenant_id]::[client_key]
  private readonly states: Map<string, KeyState> = new Map();

  constructor(cfg: RateLimitingServiceConfig = {}) {
    this.windowMs = cfg.windowMs ?? 60_000;
    this.maxTimestampsPerKey = cfg.maxTimestampsPerKey ?? 10_000;
  }

  private buildKey(tenantId: string, clientKey: string): string {
    const t = tenantId.trim();
    const c = clientKey.trim();
    return `rate::${t}::${c}`;
  }

  private nowMs(): number {
    return Date.now();
  }

  /**
   * isRateLimitExceeded
   *
   * Records the current request timestamp, then determines if it exceeds maxRequests
   * within the sliding window.
   */
  isRateLimitExceeded(
    tenantId: string,
    clientKey: string,
    maxRequests: number
  ): boolean {
    if (!tenantId.trim()) return true;
    if (!clientKey.trim()) return true;

    const max = Number.isFinite(maxRequests) ? maxRequests : 0;
    if (max <= 0) return true;

    const key = this.buildKey(tenantId, clientKey);
    const state = this.states.get(key) ?? { timestampsMs: [] };

    const cutoff = this.nowMs() - this.windowMs;

    // Drop old timestamps.
    if (state.timestampsMs.length > 0) {
      // timestampsMs is ordered by insertion time; discard from the front.
      let idx = 0;
      while (idx < state.timestampsMs.length && state.timestampsMs[idx] < cutoff) idx++;
      if (idx > 0) state.timestampsMs.splice(0, idx);
    }

    // Record current event.
    state.timestampsMs.push(this.nowMs());

    // Soft bound: if extremely bursty, truncate from the front.
    if (state.timestampsMs.length > this.maxTimestampsPerKey) {
      const extra = state.timestampsMs.length - this.maxTimestampsPerKey;
      state.timestampsMs.splice(0, extra);
    }

    this.states.set(key, state);

    // Exceeds after inserting current timestamp.
    return state.timestampsMs.length > max;
  }

  /**
   * getRemaining
   * Returns remaining requests for the current sliding window after pruning.
   */
  getRemaining(tenantId: string, clientKey: string, maxRequests: number): number {
    if (!tenantId.trim() || !clientKey.trim()) return 0;
    const key = this.buildKey(tenantId, clientKey);
    const state = this.states.get(key);
    if (!state) return maxRequests;

    const cutoff = this.nowMs() - this.windowMs;
    let idx = 0;
    while (idx < state.timestampsMs.length && state.timestampsMs[idx] < cutoff) idx++;
    if (idx > 0) state.timestampsMs.splice(0, idx);

    const remaining = maxRequests - state.timestampsMs.length;
    return remaining > 0 ? remaining : 0;
  }
}

