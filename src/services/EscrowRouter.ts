import * as crypto from 'crypto';
import * as process from 'process';

export type TenantId = string;
export type TransactionId = string;

export interface EscrowLockResult {
  transactionId: TransactionId;
  tenantId: TenantId;
  amount: number;
  lockedAtIso: string;
}

export interface MilestoneVerificationResult {
  transactionId: TransactionId;
  tenantId: TenantId;
  verified: boolean;
  milestoneIndex: number;
}

export interface ReleaseResult {
  transactionId: TransactionId;
  tenantId: TenantId;
  amount: number;
  settlementAccount: string;
  releasedAtIso: string;
}

type MetricsLevel = 'INFO' | 'WARN' | 'ERROR';

type EscrowTransactionState = 'LOCKED' | 'VERIFIED_MILESTONE' | 'RELEASED';

type TenantEscrowStateRecord = {
  tenantId: TenantId;
  pendingBalance: number;
  lockedContractValue: number;
  transactionsById: Map<TransactionId, EscrowTransactionInternal>;
};

interface EscrowTransactionInternal {
  transactionId: TransactionId;
  tenantId: TenantId;
  amount: number;
  state: EscrowTransactionState;
  lockedAtIso: string;
  milestoneVerified: boolean;
  milestoneIndex: number;
  releaseRequestedAtIso?: string;
  settlementAccount?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function logMetrics(level: MetricsLevel, event: string, details: Record<string, unknown>): void {
  const record: Record<string, unknown> = {
    ts: nowIso(),
    level,
    event,
    ...details,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

function toNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for ${fieldName}`);
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${fieldName}`);
    return parsed;
  }

  throw new Error(`Missing or invalid numeric field: ${fieldName}`);
}

function normalizeTenantId(tenantId: string): TenantId {
  const trimmed = tenantId.trim();
  if (trimmed.length === 0) throw new Error('tenantId is required');
  return trimmed;
}

function normalizeAmount(amount: unknown): number {
  const n = toNumber(amount, 'amount');
  if (n <= 0) throw new Error('amount must be > 0');
  return n;
}

function makeDeterministicTransactionId(tenantId: TenantId, amount: number, nonce: string): TransactionId {
  const hash = crypto.createHash('sha256');
  hash.update(`tenant:${tenantId}`);
  hash.update(`amount:${amount}`);
  hash.update(`nonce:${nonce}`);
  return `tx_${hash.digest('hex').slice(0, 32)}`;
}

export class EscrowRouter {
  private readonly tenantStates: Map<TenantId, TenantEscrowStateRecord> = new Map();
  private readonly maxMilestones: number;

  constructor(options?: { maxMilestones?: number }) {
    const maxMilestones = options?.maxMilestones;
    this.maxMilestones = typeof maxMilestones === 'number' && Number.isFinite(maxMilestones)
      ? Math.max(1, Math.floor(maxMilestones))
      : 3;
  }

  private getOrCreateTenantState(tenantId: TenantId): TenantEscrowStateRecord {
    const existing = this.tenantStates.get(tenantId);
    if (existing) return existing;

    const created: TenantEscrowStateRecord = {
      tenantId,
      pendingBalance: 0,
      lockedContractValue: 0,
      transactionsById: new Map<TransactionId, EscrowTransactionInternal>(),
    };

    this.tenantStates.set(tenantId, created);
    logMetrics('INFO', 'tenant_state_created', {
      tenantId,
      pendingBalance: 0,
      lockedContractValue: 0,
    });

    return created;
  }

  public lockFunds(tenantId: string, amount: number): EscrowLockResult {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const normalizedAmount = normalizeAmount(amount);

    const tenantState = this.getOrCreateTenantState(normalizedTenantId);

    const nonce = crypto.randomBytes(16).toString('hex');
    const transactionId = makeDeterministicTransactionId(normalizedTenantId, normalizedAmount, nonce);

    if (tenantState.transactionsById.has(transactionId)) {
      logMetrics('WARN', 'transaction_id_collision_retry', { tenantId: normalizedTenantId, transactionId });
      return this.lockFunds(normalizedTenantId, normalizedAmount);
    }

    tenantState.pendingBalance += normalizedAmount;
    tenantState.lockedContractValue += normalizedAmount;

    const tx: EscrowTransactionInternal = {
      transactionId,
      tenantId: normalizedTenantId,
      amount: normalizedAmount,
      state: 'LOCKED',
      lockedAtIso: nowIso(),
      milestoneVerified: false,
      milestoneIndex: 0,
    };

    tenantState.transactionsById.set(transactionId, tx);

    logMetrics('INFO', 'escrow_lockFunds_executed', {
      tenantId: normalizedTenantId,
      transactionId,
      amount: normalizedAmount,
      pendingBalance: tenantState.pendingBalance,
      lockedContractValue: tenantState.lockedContractValue,
      lockedAtIso: tx.lockedAtIso,
    });

    logMetrics('INFO', 'settlement_profile_selected', {
      tenantId: normalizedTenantId,
      settlementAccountEnvKey: 'SETTLEMENT_ACCOUNT',
    });

    return {
      transactionId,
      tenantId: normalizedTenantId,
      amount: normalizedAmount,
      lockedAtIso: tx.lockedAtIso,
    };
  }

  public verifyMilestone(transactionId: string, milestoneIndex: number): MilestoneVerificationResult {
    const txId = transactionId.trim();
    if (txId.length === 0) throw new Error('transactionId is required');

    const idx = toNumber(milestoneIndex, 'milestoneIndex');
    if (!Number.isInteger(idx)) throw new Error('milestoneIndex must be an integer');

    for (const [, tenantState] of this.tenantStates) {
      const tx = tenantState.transactionsById.get(txId);
      if (!tx) continue;

      if (tx.state === 'RELEASED') {
        logMetrics('WARN', 'escrow_verifyMilestone_after_release', {
          tenantId: tx.tenantId,
          transactionId: txId,
          milestoneIndex: idx,
        });

        return {
          transactionId: txId,
          tenantId: tx.tenantId,
          verified: false,
          milestoneIndex: tx.milestoneIndex,
        };
      }

      if (idx < 1 || idx > this.maxMilestones) {
        logMetrics('ERROR', 'escrow_verifyMilestone_invalid_index', {
          tenantId: tx.tenantId,
          transactionId: txId,
          milestoneIndex: idx,
          maxMilestones: this.maxMilestones,
        });

        return {
          transactionId: txId,
          tenantId: tx.tenantId,
          verified: false,
          milestoneIndex: tx.milestoneIndex,
        };
      }

      if (idx <= tx.milestoneIndex) {
        logMetrics('WARN', 'escrow_verifyMilestone_non_monotonic', {
          tenantId: tx.tenantId,
          transactionId: txId,
          milestoneIndex: idx,
          currentMilestoneIndex: tx.milestoneIndex,
        });

        return {
          transactionId: txId,
          tenantId: tx.tenantId,
          verified: false,
          milestoneIndex: tx.milestoneIndex,
        };
      }

      tx.milestoneIndex = idx;
      tx.milestoneVerified = true;
      tx.state = 'VERIFIED_MILESTONE';

      logMetrics('INFO', 'escrow_verifyMilestone_executed', {
        tenantId: tx.tenantId,
        transactionId: txId,
        milestoneIndex: idx,
        state: tx.state,
        lockedAtIso: tx.lockedAtIso,
      });

      return {
        transactionId: txId,
        tenantId: tx.tenantId,
        verified: true,
        milestoneIndex: idx,
      };
    }

    throw new Error(`transactionId not found for milestone verification: ${txId}`);
  }

  public releaseToSettlement(transactionId: string): ReleaseResult {
    const txId = transactionId.trim();
    if (txId.length === 0) throw new Error('transactionId is required');

    const settlementAccount = mustEnv('SETTLEMENT_ACCOUNT');

    for (const [, tenantState] of this.tenantStates) {
      const tx = tenantState.transactionsById.get(txId);
      if (!tx) continue;

      if (tx.state === 'RELEASED') {
        logMetrics('WARN', 'escrow_releaseToSettlement_already_released', {
          tenantId: tx.tenantId,
          transactionId: txId,
          settlementAccount,
        });

        return {
          transactionId: txId,
          tenantId: tx.tenantId,
          amount: tx.amount,
          settlementAccount: tx.settlementAccount ?? settlementAccount,
          releasedAtIso: tx.releaseRequestedAtIso ?? nowIso(),
        };
      }

      if (!tx.milestoneVerified || tx.state !== 'VERIFIED_MILESTONE') {
        throw new Error(`Milestone not verified for transactionId=${txId}`);
      }

      tenantState.pendingBalance -= tx.amount;
      tenantState.lockedContractValue -= tx.amount;

      if (tenantState.pendingBalance < 0) {
        logMetrics('ERROR', 'escrow_releaseToSettlement_pendingBalance_underflow', {
          tenantId: tx.tenantId,
          transactionId: txId,
          pendingBalanceAfter: tenantState.pendingBalance,
        });
        tenantState.pendingBalance = 0;
      }

      if (tenantState.lockedContractValue < 0) {
        logMetrics('ERROR', 'escrow_releaseToSettlement_lockedContractValue_underflow', {
          tenantId: tx.tenantId,
          transactionId: txId,
          lockedContractValueAfter: tenantState.lockedContractValue,
        });
        tenantState.lockedContractValue = 0;
      }

      tx.state = 'RELEASED';
      tx.releaseRequestedAtIso = nowIso();
      tx.settlementAccount = settlementAccount;

      this.executeClearingLoop({
        tenantId: tx.tenantId,
        transactionId: txId,
        amount: tx.amount,
        settlementAccount,
      });

      logMetrics('INFO', 'escrow_releaseToSettlement_executed', {
        tenantId: tx.tenantId,
        transactionId: txId,
        amount: tx.amount,
        settlementAccount,
        releasedAtIso: tx.releaseRequestedAtIso,
        pendingBalance: tenantState.pendingBalance,
        lockedContractValue: tenantState.lockedContractValue,
      });

      return {
        transactionId: txId,
        tenantId: tx.tenantId,
        amount: tx.amount,
        settlementAccount,
        releasedAtIso: tx.releaseRequestedAtIso,
      };
    }

    throw new Error(`transactionId not found for release: ${txId}`);
  }

  private executeClearingLoop(input: {
    tenantId: TenantId;
    transactionId: TransactionId;
    amount: number;
    settlementAccount: string;
  }): void {
    const steps = 3;

    for (let i = 0; i < steps; i++) {
      logMetrics('INFO', 'clearing_loop_step', {
        step: i + 1,
        stepsTotal: steps,
        tenantId: input.tenantId,
        transactionId: input.transactionId,
        routedSettlementAccount: input.settlementAccount,
        amount: input.amount,
        phase: i === steps - 1 ? 'finalize' : 'process',
      });
    }
  }

  public getTenantSnapshot(tenantId: string): { tenantId: TenantId; pendingBalance: number; lockedContractValue: number; transactionCount: number } {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const tenantState = this.getOrCreateTenantState(normalizedTenantId);
    return {
      tenantId: tenantState.tenantId,
      pendingBalance: tenantState.pendingBalance,
      lockedContractValue: tenantState.lockedContractValue,
      transactionCount: tenantState.transactionsById.size,
    };
  }
}

