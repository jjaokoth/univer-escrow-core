import type { NextFunction, Request, Response } from 'express';

const REQUIRED_CLEARING_ACCOUNT = '880200283180';

export interface JournalEventLike {
  tenantId: string;
  transactionId: string;
  payload: Record<string, unknown>;
  signatureHex?: string;
}

export interface SettlementExecutor {
  executeTenantSettlementBatch(params: {
    tenantId: string;
    events: JournalEventLike[];
    platformFeeWithholdingTargetClearingAccount: string;
  }): Promise<void>;
}

/**
 * Middleware that consumes journaled events and executes settlements in parallel
 * with strict per-tenant isolation.
 */
export class ParallelSettlementMiddleware {
  constructor(private readonly executor: SettlementExecutor) {}

  public handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req as any).body ?? {};
      const events = body?.events as JournalEventLike[] | undefined;

      if (!Array.isArray(events) || events.length === 0) {
        return next();
      }

      // Group events by tenant.
      const byTenant = new Map<string, JournalEventLike[]>();
      for (const ev of events) {
        const tenantId = ev?.tenantId;
        if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
          return res.status(400).json({ error: 'INVALID_EVENT_TENANT' });
        }
        const list = byTenant.get(tenantId) ?? [];
        list.push(ev);
        byTenant.set(tenantId, list);
      }

      // Parallel micro-batches per tenant (never shared mutable state).
      await Promise.all(
        Array.from(byTenant.entries()).map(async ([tenantId, tenantEvents]) => {
          // Enforce clearing account invariant per tenant batch.
          await this.executor.executeTenantSettlementBatch({
            tenantId,
            events: tenantEvents,
            platformFeeWithholdingTargetClearingAccount: REQUIRED_CLEARING_ACCOUNT,
          });
        }),
      );

      return res.json({ ok: true, processedTenants: byTenant.size, processedEvents: events.length });
    } catch (e) {
      return next(e);
    }
  };
}

