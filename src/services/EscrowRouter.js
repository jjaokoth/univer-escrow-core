"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EscrowRouter = void 0;
const crypto = __importStar(require("crypto"));
const process = __importStar(require("process"));
function nowIso() {
    return new Date().toISOString();
}
function mustEnv(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function logMetrics(level, event, details) {
    const record = {
        ts: nowIso(),
        level,
        event,
        ...details,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
}
function toNumber(value, fieldName) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error(`Invalid numeric value for ${fieldName}`);
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed))
            throw new Error(`Invalid numeric value for ${fieldName}`);
        return parsed;
    }
    throw new Error(`Missing or invalid numeric field: ${fieldName}`);
}
function normalizeTenantId(tenantId) {
    const trimmed = tenantId.trim();
    if (trimmed.length === 0)
        throw new Error('tenantId is required');
    return trimmed;
}
function normalizeAmount(amount) {
    const n = toNumber(amount, 'amount');
    if (n <= 0)
        throw new Error('amount must be > 0');
    return n;
}
function makeDeterministicTransactionId(tenantId, amount, nonce) {
    const hash = crypto.createHash('sha256');
    hash.update(`tenant:${tenantId}`);
    hash.update(`amount:${amount}`);
    hash.update(`nonce:${nonce}`);
    return `tx_${hash.digest('hex').slice(0, 32)}`;
}
class EscrowRouter {
    constructor(options) {
        this.tenantStates = new Map();
        const maxMilestones = options?.maxMilestones;
        this.maxMilestones = typeof maxMilestones === 'number' && Number.isFinite(maxMilestones)
            ? Math.max(1, Math.floor(maxMilestones))
            : 3;
    }
    getOrCreateTenantState(tenantId) {
        const existing = this.tenantStates.get(tenantId);
        if (existing)
            return existing;
        const created = {
            tenantId,
            pendingBalance: 0,
            lockedContractValue: 0,
            transactionsById: new Map(),
        };
        this.tenantStates.set(tenantId, created);
        logMetrics('INFO', 'tenant_state_created', {
            tenantId,
            pendingBalance: 0,
            lockedContractValue: 0,
        });
        return created;
    }
    lockFunds(tenantId, amount) {
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
        const tx = {
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
    verifyMilestone(transactionId, milestoneIndex) {
        const txId = transactionId.trim();
        if (txId.length === 0)
            throw new Error('transactionId is required');
        const idx = toNumber(milestoneIndex, 'milestoneIndex');
        if (!Number.isInteger(idx))
            throw new Error('milestoneIndex must be an integer');
        for (const [, tenantState] of this.tenantStates) {
            const tx = tenantState.transactionsById.get(txId);
            if (!tx)
                continue;
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
    releaseToSettlement(transactionId) {
        const txId = transactionId.trim();
        if (txId.length === 0)
            throw new Error('transactionId is required');
        const settlementAccount = mustEnv('SETTLEMENT_ACCOUNT');
        for (const [, tenantState] of this.tenantStates) {
            const tx = tenantState.transactionsById.get(txId);
            if (!tx)
                continue;
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
    executeClearingLoop(input) {
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
    getTenantSnapshot(tenantId) {
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
exports.EscrowRouter = EscrowRouter;
