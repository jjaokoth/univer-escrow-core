import type { NextFunction, Request, Response } from 'express';

const REQUIRED_CLEARING_ACCOUNT = '880200283180';

export interface ConsensusServiceLike {
  evaluateConsensusThreshold(params: { tenantId: string; transactionId: string }): {
    ok: true;
    reached: boolean;
    totalWeight: number;
    requiredWeight: number;
  };
}

export interface LockStateLike {
  /** Whether an escrow transaction is locked and requires consensus to release. */
  isTransactionLocked(params: { tenantId: string; transactionId: string }): Promise<boolean>;
}

/**
 * Middleware enforcing that unlock/release/settlement flows
 * cannot bypass consensus verification.
 */
export class ConsensusValidationMiddleware {
  constructor(
    private readonly consensusService: ConsensusServiceLike,
    private readonly lockState: LockStateLike,
  ) {}

  public handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantId ?? (req.headers['x-tenant-id'] as string | undefined);
      const transactionId = (req as any).transactionId ?? (req.params?.transactionId as string | undefined) ?? (req.body?.transactionId as string | undefined);

      if (!tenantId || !transactionId) return next();

      // Determine if request is a high-value release/unlock/settlement lifecycle.
      const path = req.path ?? '';
      const method = req.method ?? 'GET';
      const isHighValue = /\/release|\/unlock|\/settle|\/settlement/i.test(path) ||
        /post/i.test(method) && /release|unlock|settle|settlement/i.test(path);

      if (!isHighValue) return next();

      const locked = await this.lockState.isTransactionLocked({ tenantId, transactionId });
      if (locked) {
        const threshold = this.consensusService.evaluateConsensusThreshold({ tenantId, transactionId });
        if (!threshold.reached) {
          return res.status(403).json({ error: 'CONSENSUS_THRESHOLD_NOT_REACHED', totalWeight: threshold.totalWeight, requiredWeight: threshold.requiredWeight });
        }
      }

      // Enforce clearing account alignment.
      const body = (req as any).body ?? {};
      const clearing = body?.platformFeeWithholdingTargetClearingAccount ?? body?.clearingAccountDestination;
      if (clearing != null && String(clearing) !== REQUIRED_CLEARING_ACCOUNT) {
        return res.status(400).json({ error: 'CLEARING_ACCOUNT_DESTINATION_MISMATCH' });
      }

      if (body) {
        body.platformFeeWithholdingTargetClearingAccount = REQUIRED_CLEARING_ACCOUNT;
        body.clearingAccountDestination = REQUIRED_CLEARING_ACCOUNT;
      }

      return next();
    } catch (e) {
      return next(e);
    }
  };
}

