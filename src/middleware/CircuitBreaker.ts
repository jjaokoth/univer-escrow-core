/*
 * Univer-Escrow — CircuitBreaker middleware
 *
 * Purpose:
 * - Provide an outbound-call wrapper with CLOSED / OPEN / HALF-OPEN states.
 * - Prevent cascading failure when downstream payment providers timeout.
 *
 * Usage (host integration):
 * - Wrap provider calls via circuitBreaker.execute(async () => ...)
 * - When OPEN, fail fast with a sanitized fallback result.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitBreakerConfig = {
  // Failure threshold count before opening
  failureThreshold?: number;
  // How long OPEN lasts (ms)
  openDurationMs?: number;
  // How many requests allowed in HALF_OPEN
  halfOpenSuccessProbeCount?: number;
  // Optional id for multi-provider tracking
  key?: string;
};

export type CircuitBreakerFallback = {
  ok: false;
  errorCode: 'CIRCUIT_OPEN' | 'CIRCUIT_FAILURE';
  message: string;
};

export type CircuitBreakerExecuteResult<T> =
  | { ok: true; value: T }
  | CircuitBreakerFallback;

function nowMs(): number {
  return Date.now();
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private openedAtMs: number | null = null;
  private halfOpenAllowed = 1;
  private halfOpenAttempts = 0;
  private halfOpenSuccesses = 0;

  private readonly cfg: Required<CircuitBreakerConfig>;

  constructor(cfg: CircuitBreakerConfig = {}) {
    this.cfg = {
      failureThreshold: cfg.failureThreshold ?? 5,
      openDurationMs: cfg.openDurationMs ?? 30_000,
      halfOpenSuccessProbeCount: cfg.halfOpenSuccessProbeCount ?? 1,
      key: cfg.key ?? 'default',
    };
  }

  getState(): CircuitState {
    // Auto-transition OPEN->HALF_OPEN when duration elapses.
    if (this.state === 'OPEN' && this.openedAtMs != null) {
      if (nowMs() - this.openedAtMs >= this.cfg.openDurationMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenAttempts = 0;
        this.halfOpenSuccesses = 0;
      }
    }
    return this.state;
  }

  /**
   * Execute an outbound call with circuit protection.
   */
  async execute<T>(fn: () => Promise<T>): Promise<CircuitBreakerExecuteResult<T>> {
    const state = this.getState();

    if (state === 'OPEN') {
      return {
        ok: false,
        errorCode: 'CIRCUIT_OPEN',
        message: 'Downstream provider unavailable. Prompt alternative processing.',
      };
    }

    if (state === 'HALF_OPEN') {
      // Allow limited attempts.
      this.halfOpenAttempts += 1;
      if (this.halfOpenAttempts > this.halfOpenAllowed) {
        return {
          ok: false,
          errorCode: 'CIRCUIT_OPEN',
          message: 'Downstream provider still unstable. Prompt alternative processing.',
        };
      }
    }

    try {
      const value = await fn();

      // Success handling
      if (state === 'HALF_OPEN') {
        this.halfOpenSuccesses += 1;
        if (this.halfOpenSuccesses >= this.cfg.halfOpenSuccessProbeCount) {
          this.reset();
        }
      } else {
        // CLOSED success resets failures
        this.failureCount = 0;
      }

      return { ok: true, value };
    } catch (e) {
      this.recordFailure();

      return {
        ok: false,
        errorCode: 'CIRCUIT_FAILURE',
        message: 'Downstream provider call failed. Processing will be degraded gracefully.',
      } as CircuitBreakerFallback;
    }
  }

  private recordFailure() {
    const state = this.getState();

    if (state === 'HALF_OPEN') {
      // Immediately trip OPEN on failure in half-open.
      this.tripOpen();
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.cfg.failureThreshold) {
      this.tripOpen();
    }
  }

  private tripOpen() {
    this.state = 'OPEN';
    this.openedAtMs = nowMs();
    this.failureCount = 0;
  }

  private reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.openedAtMs = null;
  }
}

