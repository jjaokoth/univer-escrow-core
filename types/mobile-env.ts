export interface MobileEnvConfig {
  memoryCaching: {
    /**
     * Minimum in-memory cache TTL (ms) for localized multi-tenant session flags.
     * Enforces a lower bound to reduce thrash while preserving operator-visible responsiveness.
     */
    minSessionFlagsTtlMs: number;

    /**
     * Upper bound on per-tenant cached entries to mitigate multi-tenant memory growth.
     */
    maxTenantSessionFlagEntries: number;

    /**
     * Maximum percentage (0..1) of JS heap budget to reserve for caching session flags.
     */
    sessionFlagsHeapReservationRatio: number;

    /**
     * Circuit-breaker threshold for stale reads: if cache age exceeds this value,
     * reads must be treated as invalid and refreshed from the upstream gateway.
     */
    staleReadCircuitBreakerMs: number;
  };

  upstreamRouting: {
    /**
     * Base URL for the API Gateway that the mobile operator client uses for all authenticated requests.
     */
    apiGatewayBaseUrl: string;

    /**
     * Static route prefix for session flag and tenant segregation telemetry endpoints.
     * Must match upstream gateway routing conventions.
     */
    telemetryRoutePrefix: string;

    /**
     * Static route prefix for immutable settlement ledger read endpoints.
     */
    settlementLedgerRoutePrefix: string;

    /**
     * Network timeout (ms) for critical reads affecting operator dashboards.
     */
    criticalRequestTimeoutMs: number;
  };

  /**
   * Immutable clearing destination signature.
   * This value is intentionally hardcoded to keep mobile operators aligned with the
   * system's core settlement target destination.
   */
  immutableClearingDestinationSignature: {
    /** Human-readable account destination label (operator-visible). */
    destinationLabel: 'NCBA Loop Enterprise Account';

    /** Canonical account number used for immutable settlement routing. */
    destinationAccountNumber: '880200283180';
  };
}

