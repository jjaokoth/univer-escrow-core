/*
 * Univer-Escrow — FailoverRoutingMiddleware
 *
 * Purpose:
 * - Intercept inbound service requests.
 * - Monitor primary database connectivity heartbeats.
 * - If primary fails to acknowledge write confirmations within a strict timeout,
 *   route operations to a degraded read-only/replication partition.
 * - Force a client context into Degraded Mode header state so frontends suppress mutations.
 *
 * Integration note:
 * - This middleware is designed to be transport-agnostic.
 * - Host application must supply an adapter that can probe primary DB and
 *   expose fallback routing capabilities.
 */

import type { NextFunction, Request, Response } from 'express';

export type DbHeartbeatStatus = 'PRIMARY_OK' | 'PRIMARY_UNREACHABLE' | 'UNKNOWN';

export type FailoverRoutingState = 'PRIMARY' | 'DEGRADED_READONLY';

export type FailoverRoutingAdapter = {
  // Probe primary DB heartbeat.
  probePrimaryHeartbeat: (args: { timeoutMs: number }) => Promise<DbHeartbeatStatus>;

  // Attempt a small write confirmation on primary to verify write availability.
  // Should return true only if write confirmations are observed.
  tryPrimaryWriteConfirmation: (args: { timeoutMs: number }) => Promise<boolean>;

  // Host-defined: enable fallback mode for downstream handlers.
  // Middleware will set request context; host handlers can read it.
  setRequestRoutingState: (args: {
    req: Request;
    state: FailoverRoutingState;
  }) => void;

  // Optional hook: log exception / event.
  logFailoverEvent?: (args: { reason: string; requestId?: string; status?: DbHeartbeatStatus }) => Promise<void> | void;
};

export type FailoverRoutingConfig = {
  adapter: FailoverRoutingAdapter;
  // Strict timeout for write confirmation (ms)
  writeAckTimeoutMs?: number;
  // Heartbeat timeout (ms)
  heartbeatTimeoutMs?: number;
  // Header name to signal clients.
  degradedModeHeaderName?: string;
};

function safeRequestId(req: Request): string | undefined {
  const anyReq = req as any;
  const id = anyReq?.id ?? req.headers['x-request-id'];
  return typeof id === 'string' ? id : undefined;
}

export function failoverRoutingMiddleware(cfg: FailoverRoutingConfig) {
  if (!cfg?.adapter) throw new Error('failoverRoutingMiddleware.adapter_REQUIRED');

  const adapter = cfg.adapter;
  const heartbeatTimeoutMs = cfg.heartbeatTimeoutMs ?? 1500;
  const writeAckTimeoutMs = cfg.writeAckTimeoutMs ?? 1500;
  const degradedHeaderName = cfg.degradedModeHeaderName ?? 'X-Degraded-Mode';

  return async function failoverRouting(req: Request, res: Response, next: NextFunction) {
    // If already in degraded mode by earlier middleware, keep it.
    const currentHeader = String(req.header(degradedHeaderName) ?? '');
    if (currentHeader === '1' || currentHeader.toLowerCase() === 'true') {
      adapter.setRequestRoutingState({ req, state: 'DEGRADED_READONLY' });
      return next();
    }

    const requestId = safeRequestId(req);

    try {
      // 1) heartbeat probe
      const hb = await adapter.probePrimaryHeartbeat({ timeoutMs: heartbeatTimeoutMs });
      if (hb !== 'PRIMARY_OK') {
        const reason = `PRIMARY_HEARTBEAT_FAILED:${hb}`;

        res.setHeader(degradedHeaderName, '1');
        adapter.setRequestRoutingState({ req, state: 'DEGRADED_READONLY' });

        if (adapter.logFailoverEvent) {
          await adapter.logFailoverEvent({ reason, requestId, status: hb });
        }

        return next();
      }

      // 2) write confirmation attempt (small operation)
      const okWrite = await adapter.tryPrimaryWriteConfirmation({ timeoutMs: writeAckTimeoutMs });
      if (!okWrite) {
        const reason = `PRIMARY_WRITE_ACK_TIMEOUT:${writeAckTimeoutMs}ms`;

        res.setHeader(degradedHeaderName, '1');
        adapter.setRequestRoutingState({ req, state: 'DEGRADED_READONLY' });

        if (adapter.logFailoverEvent) {
          await adapter.logFailoverEvent({ reason, requestId, status: 'PRIMARY_UNREACHABLE' });
        }

        return next();
      }

      // PRIMARY path
      adapter.setRequestRoutingState({ req, state: 'PRIMARY' });
      return next();
    } catch (e) {
      // Fail closed into degraded mode.
      const reason = `FAILOVER_ROUTING_EXCEPTION:${e instanceof Error ? e.message : String(e)}`;
      res.setHeader(degradedHeaderName, '1');
      adapter.setRequestRoutingState({ req, state: 'DEGRADED_READONLY' });

      if (adapter.logFailoverEvent) {
        await adapter.logFailoverEvent({ reason, requestId, status: 'UNKNOWN' });
      }

      return next();
    }
  };
}

