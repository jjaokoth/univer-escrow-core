/*
 * PublicInterfaces.d.ts
 * ----------------------------------------------------
 * Public abstract interface declarations for the Univer Escrow
 * verification/prospectus surface.
 *
 * Design intent:
 * - Expose type-safe contracts only.
 * - Withhold internal procedural blocks to protect implementation IP.
 * - Provide stable method signatures for third-party auditors.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

export type ProofInputSecretPayload = {
  [k: string]: unknown;
};

export type PublicInputs = {
  [k: string]: unknown;
};

export type ZkAnonymizerTokenPayload = {
  tenantId: string;
  proofCommitment: string;
  proofHash: string;
  publicInputsHash: string;
};

export type ProofAuthenticityResult = {
  ok: true;
  valid: boolean;
  details?: Record<string, unknown>;
};

export interface ProofAuthenticityValidator {
  validate(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<boolean>;
}

export interface ProofCommitmentStrategy {
  commit(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<string>;
}

export interface ZeroKnowledgeAnonymizerService {
  /**
   * Performs out-of-band consistency checks for the provided inputs.
   */
  evaluateProofAuthenticity(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<ProofAuthenticityResult>;

  /**
   * Produces a deterministic, non-interactive verification token payload.
   */
  generateAnonymizedProof(params: {
    tenantId: string;
    inputSecretPayload: ProofInputSecretPayload;
    publicInputs: PublicInputs;
  }): Promise<{ token: string; tokenPayload: ZkAnonymizerTokenPayload }>;
}

export type DestinationRoutingParameters = Record<string, unknown>;

export type NcbaBankConfirmationToken = {
  confirmationId: string;
  tenantId: string;
  transactionId: string;
  amount: number;
  clearingAccount: string;
  routedTo: DestinationRoutingParameters;
};

export interface NcbaBankSender {
  sendSettlement(params: {
    tenantId: string;
    transactionAmount: number;
    clearingAccount: string;
    destinationRoutingParameters: DestinationRoutingParameters;
    splits: { feeTotal: number; netTotal: number };
  }): Promise<{ ok: true; bankReference: string }>;
}

export interface NcbaLoopSettlementService {
  /**
   * Executes NCBA settlement clearance with strict clearing-account routing.
   */
  executeNcbaSettlementClearance(params: {
    tenantId: string;
    transactionAmount: number;
    destinationRoutingParameters: DestinationRoutingParameters;
  }): Promise<NcbaBankConfirmationToken>;
}

export type EventEnvelope<T extends JsonValue = JsonValue> = {
  tenantId: string;
  eventType: string;
  createdAt: string; // ISO-8601
  payload: T;
  correlationId?: string;
};

export interface SharedMemoryEventBusService {
  /**
   * Publish an internal event envelope into the in-memory event bus boundary.
   */
  publishInternalEvent<T extends JsonValue = JsonValue>(
    envelope: EventEnvelope<T>
  ): Promise<void>;

  /** Subscribe to events by type for the owning tenant. */
  subscribe<T extends JsonValue = JsonValue>(params: {
    tenantId: string;
    eventType: string;
    onEvent: (envelope: EventEnvelope<T>) => void | Promise<void>;
  }): Promise<{ unsubscribe: () => void }>;
}

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

export interface DatabaseShardOrchestratorService {
  /**
   * Triggers tenant-scoped shard migration.
   */
  triggerTenantShardMigration(params: {
    tenantId: string;
    targetShardConnectionConfiguration: string;
  }): Promise<{ tenantId: string; ok: true; migrationId: string }>;

  /**
   * Returns latest utilization snapshot.
   */
  checkShardUtilization(params: { tenantId: string }): Promise<TenantShardState['lastUtilization']>;
}

