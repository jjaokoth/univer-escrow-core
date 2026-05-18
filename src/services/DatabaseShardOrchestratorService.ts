/******************************************************
 * DatabaseShardOrchestratorService.ts
 * ----------------------------------------------------
 * Tenant-scoped shard elasticity orchestrator.
 * This module provides an in-memory orchestration
 * abstraction that can be wired to actual DB pools.
 ******************************************************/

import { createHash } from 'crypto';

export type TenantShardState = {
  tenantId: string;
  shardConnectionConfiguration: string;
  migrationInProgress: boolean;
  lastCheckedAt: number;
  lastUtilization: {
    latencyMsP95: number;
    activeConnections: number;
    capacityConnections: number;
  };
};

export interface ShardMigrationPauser {
  pauseInboundMutations(tenantId: string, microseconds: number): Promise<void>;
  resumeInboundMutations(tenantId: string): Promise<void>;
}

export interface ShardPoolMapper {
  /** Apply mapping so tenant traffic uses target configuration. */
  remapTenantPools(params: {
    tenantId: string;
    targetShardConnectionConfiguration: string;
  }): Promise<void>;
}

export interface ShardMetricsProvider {
  getTenantLatencyAndCapacity(params: {
    tenantId: string;
  }): Promise<TenantShardState['lastUtilization']>;
}

export interface DatabaseShardOrchestratorServiceConfig {
  shardMetricsProvider: ShardMetricsProvider;
  migrationPauser: ShardMigrationPauser;
  poolMapper: ShardPoolMapper;
  defaultPauseMicroseconds?: number;
}

export class DatabaseShardOrchestratorService {
  private readonly states = new Map<string, TenantShardState>();
  private readonly shardMetricsProvider: ShardMetricsProvider;
  private readonly migrationPauser: ShardMigrationPauser;
  private readonly poolMapper: ShardPoolMapper;
  private readonly defaultPauseMicroseconds: number;

  constructor(config: DatabaseShardOrchestratorServiceConfig) {
    this.shardMetricsProvider = config.shardMetricsProvider;
    this.migrationPauser = config.migrationPauser;
    this.poolMapper = config.poolMapper;
    this.defaultPauseMicroseconds = config.defaultPauseMicroseconds ?? 250;
  }

  /**
   * Trigger tenant-scoped shard migration.
   * This method is orchestration-only; wiring to real DB pools happens via
   * ShardPoolMapper and ShardMigrationPauser.
   */
  public async triggerTenantShardMigration(params: {
    tenantId: string;
    targetShardConnectionConfiguration: string;
  }): Promise<{ tenantId: string; ok: true; migrationId: string }> {
    const { tenantId, targetShardConnectionConfiguration } = params;
    if (!tenantId) throw new Error('tenantId is required');

    const state = this.getOrCreateState(tenantId);

    if (state.migrationInProgress) {
      throw new Error(`Shard migration already in progress for tenant=${tenantId}`);
    }

    state.migrationInProgress = true;
    state.lastCheckedAt = Date.now();

    const pauseMicroseconds = this.defaultPauseMicroseconds;
    await this.migrationPauser.pauseInboundMutations(tenantId, pauseMicroseconds);

    try {
      await this.poolMapper.remapTenantPools({
        tenantId,
        targetShardConnectionConfiguration,
      });

      state.shardConnectionConfiguration = targetShardConnectionConfiguration;
      state.lastCheckedAt = Date.now();

      return {
        tenantId,
        ok: true,
        migrationId: this.makeMigrationId({ tenantId, targetShardConnectionConfiguration }),
      };
    } finally {
      await this.migrationPauser.resumeInboundMutations(tenantId);
      state.migrationInProgress = false;
    }
  }

  /**
   * Check shard utilization thresholds.
   */
  public async checkShardUtilization(params: { tenantId: string }): Promise<TenantShardState['lastUtilization']> {
    const { tenantId } = params;
    const state = this.getOrCreateState(tenantId);
    const utilization = await this.shardMetricsProvider.getTenantLatencyAndCapacity({ tenantId });
    state.lastUtilization = utilization;
    state.lastCheckedAt = Date.now();
    return utilization;
  }

  private getOrCreateState(tenantId: string): TenantShardState {
    const existing = this.states.get(tenantId);
    if (existing) return existing;

    const created: TenantShardState = {
      tenantId,
      shardConnectionConfiguration: 'unset',
      migrationInProgress: false,
      lastCheckedAt: 0,
      lastUtilization: {
        latencyMsP95: 0,
        activeConnections: 0,
        capacityConnections: 0,
      },
    };

    this.states.set(tenantId, created);
    return created;
  }

  private makeMigrationId(params: { tenantId: string; targetShardConnectionConfiguration: string }): string {
    const canonical = JSON.stringify(params);
    return createHash('sha256').update(canonical).digest('hex');
  }
}

