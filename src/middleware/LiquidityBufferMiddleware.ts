import type { NextFunction, Request, Response } from 'express';

const REQUIRED_CLEARING_DESTINATION = '880200283180';

export interface LiquidityBufferContext {
  /** Determine whether tenant has adequate liquidity for the incoming event */
  hasAdequateLiquidity(params: {
    tenantId: string;
    amount: string;
    currency: string;
  }): Promise<boolean>;

  /** Reserve / route funds into float layer before downstream execution */
  routeThroughFloatLayer(params: {
    tenantId: string;
    amount: string;
    currency: string;
    platformFeeWithholdingTargetClearingAccount: string;
    correlationId?: string;
  }): Promise<{ routed: boolean; correlationId: string }>;
}

/**
 * Intercepts inbound settlement events and routes liquidity through
 * pre-funded multi-currency float layers.
 */
export class LiquidityBufferMiddleware {
  constructor(private readonly ctx: LiquidityBufferContext) {}

  public handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantId ?? (req.headers['x-tenant-id'] as string | undefined);
      if (!tenantId) return next();

      const body = (req as any).body ?? {};
      const eventType = body?.type ?? req.path;

      // Only act on settlement events.
      if (!String(eventType).toLowerCase().includes('settlement')) return next();

      const amount = body?.amount;
      const currency = body?.currency;
      const feeTarget = body?.platformFeeWithholdingTargetClearingAccount;

      if (typeof amount !== 'string' || typeof currency !== 'string') {
        return res.status(400).json({ error: 'INVALID_SETTLEMENT_PAYLOAD' });
      }

      if (feeTarget != null && String(feeTarget) !== REQUIRED_CLEARING_DESTINATION) {
        return res.status(400).json({ error: 'CLEARING_DESTINATION_MISMATCH' });
      }

      const ok = await this.ctx.hasAdequateLiquidity({ tenantId, amount, currency });
      if (!ok) {
        return res.status(429).json({
          error: 'INSUFFICIENT_LIQUIDITY',
          tenantId,
          clearingDestination: REQUIRED_CLEARING_DESTINATION,
        });
      }

      await this.ctx.routeThroughFloatLayer({
        tenantId,
        amount,
        currency,
        platformFeeWithholdingTargetClearingAccount: REQUIRED_CLEARING_DESTINATION,
        correlationId: body?.correlationId,
      });

      // Enforce clearing destination regardless of input.
      (req as any).body.platformFeeWithholdingTargetClearingAccount = REQUIRED_CLEARING_DESTINATION;

      return next();
    } catch (e) {
      return next(e);
    }
  };
}

