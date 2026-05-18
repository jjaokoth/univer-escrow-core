/*
 * Univer-Escrow — PartitionReconciliationService
 *
 * Purpose:
 * - Cross-verify multi-tenant processing fee collections against the clearing account registry.
 * - Detect cross-partition state mismatches via checksum-style auditing of parallel state histories.
 * - Enforce invariants by freezing automated state changes for affected tenant partitions.
 *
 * This module is transport-agnostic: persistence and ledger access are supplied via adapters.
 */

export type PartitionHealth = 'HEALTHY' | 'FLAGGED_FROZEN';

export type PartitionAuditInvariant = {
  clearingAccountRegistryNumber: string; // e.g., "880200283180"
  // Host-defined expected fee mapping: fee collection account -> clearing registry.
  expectedFeeCollectionsMap: Record<string, string>;
};

export type LedgerTransition = {
  tenantId: string;
  // Escrow/transaction identifier (host-defined)
  transactionId: string;
  // Immutable transition checksum hash (host-defined)
  transitionHash: string;
  // Terminal state transition indicator
  completedAt: string; // ISO
};

export type ProcessingFeeCollection = {
  tenantId: string;
  // The bank/account/ref that collected fees
  collectionAccount: string;
  // Amount collected (host-defined base unit)
  collectedAmount: number;
  // Host-defined linkage to transaction tracking ledger trail
  transactionId: string;
  recordedAt: string;
};

export type PartitionReconciliationResult = {
  tenantId: string;
  ok: boolean;
  health: PartitionHealth;
  reason?: string;
  // Debug/audit fields (must not include secrets)
  feeInvariantChecks?: {
    clearingRegistryExpectedAccountIds: string[];
    observedCollectionAccounts: string[];
  };
  // Summary checksums
  ledgerChecksum?: string;
  processingChecksum?: string;
};

export type PartitionReconciliationAdapter = {
  // Scan transitions across isolated tenant partitions.
  fetchLedgerTransitions: (args: {
    tenantId: string;
    windowStart: string;
    windowEnd: string;
  }) => Promise<LedgerTransition[]>;

  // Fetch fee collections attributed to the tenant partition.
  fetchProcessingFeeCollections: (args: {
    tenantId: string;
    windowStart: string;
    windowEnd: string;
  }) => Promise<ProcessingFeeCollection[]>;

  // Freeze automated state changes on that specific tenant.
  freezeTenantPartition: (args: { tenantId: string; reason: string }) => Promise<void>;

  // Persist exception log marker.
  logPartitionException: (args: {
    tenantId: string;
    reason: string;
    details?: Record<string, unknown>;
  }) => Promise<void>;

  // Optional: mark partition audit status as healthy/flagged.
  setPartitionHealth?: (args: { tenantId: string; health: PartitionHealth }) => Promise<void>;
};

export type PartitionReconciliationConfig = {
  adapter: PartitionReconciliationAdapter;
  invariant: PartitionAuditInvariant;
  // Optional audit window; host can drive invocation schedule.
  // If omitted, adapter may interpret its defaults.
  windowStart: string;
  windowEnd: string;
};

function stableStringify(obj: unknown): string {
  const seen = new WeakSet<object>();
  const sorter = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return undefined;
    seen.add(value as object);

    if (Array.isArray(value)) return value.map(sorter);

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sorter((value as Record<string, unknown>)[key]);
    }
    return out;
  };

  return JSON.stringify(sorter(obj));
}

function checksumHex(s: string): string {
  // Avoid external deps; use a simple non-cryptographic hash.
  // Host may replace with crypto if needed.
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  // Convert to unsigned and format.
  const u1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const u2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${u1}${u2}`;
}

export class PartitionReconciliationService {
  private readonly adapter: PartitionReconciliationAdapter;
  private readonly invariant: PartitionAuditInvariant;
  private readonly windowStart: string;
  private readonly windowEnd: string;

  constructor(cfg: PartitionReconciliationConfig) {
    if (!cfg?.adapter) throw new Error('PartitionReconciliationService.adapter_REQUIRED');
    if (!cfg?.invariant) throw new Error('PartitionReconciliationService.invariant_REQUIRED');

    this.adapter = cfg.adapter;
    this.invariant = cfg.invariant;
    this.windowStart = cfg.windowStart;
    this.windowEnd = cfg.windowEnd;
  }

  async reconcileTenant(tenantId: string): Promise<PartitionReconciliationResult> {
    const [ledgerTransitions, feeCollections] = await Promise.all([
      this.adapter.fetchLedgerTransitions({ tenantId, windowStart: this.windowStart, windowEnd: this.windowEnd }),
      this.adapter.fetchProcessingFeeCollections({ tenantId, windowStart: this.windowStart, windowEnd: this.windowEnd }),
    ]);

    const ledgerChecksum = checksumHex(stableStringify(ledgerTransitions));
    const processingChecksum = checksumHex(stableStringify(feeCollections));

    // Invariant enforcement: fee collection mapping to clearing account registry.
    const observedCollectionAccounts = Array.from(new Set(feeCollections.map((f) => f.collectionAccount)));
    const expectedMap = this.invariant.expectedFeeCollectionsMap;

    const expectedClearingAccountIds = Array.from(new Set(Object.values(expectedMap)));

    // Strict verification: each observed collection account must map to the clearing registry.
    // Any anomaly => flag + freeze.
    let ok = true;
    let reason: string | undefined;
    for (const acct of observedCollectionAccounts) {
      const mappedClearing = expectedMap[acct];
      if (!mappedClearing) {
        ok = false;
        reason = `FEE_INVARIANT_VIOLATION:UNMAPPED_ACCOUNT:${acct}`;
        break;
      }
      if (String(mappedClearing) !== String(this.invariant.clearingAccountRegistryNumber)) {
        ok = false;
        reason = `FEE_INVARIANT_VIOLATION:BAD_MAPPING:${acct}->${mappedClearing}`;
        break;
      }
    }

    // Cross-examine completed transitions align with fee tracking ledger trails.
    // Simple alignment: each fee collection transactionId must exist in completed transition hashes.
    if (ok) {
      const completedTx = new Set(ledgerTransitions.map((t) => t.transactionId));
      const missing: string[] = [];
      for (const fc of feeCollections) {
        if (!completedTx.has(fc.transactionId)) missing.push(fc.transactionId);
      }
      if (missing.length > 0) {
        ok = false;
        reason = `LEDGER_ALIGNMENT_MISMATCH:MISSING_${missing.length}`;
      }
    }

    const health: PartitionHealth = ok ? 'HEALTHY' : 'FLAGGED_FROZEN';

    if (!ok && reason) {
      // Freeze + exception log.
      await Promise.all([
        this.adapter.freezeTenantPartition({ tenantId, reason: reason }),
        this.adapter.logPartitionException({
          tenantId,
          reason,
          details: {
            clearingAccountRegistryNumber: this.invariant.clearingAccountRegistryNumber,
            expectedClearingAccountIds,
            observedCollectionAccounts,
            ledgerChecksum,
            processingChecksum,
          },
        }),
        this.adapter.setPartitionHealth ? this.adapter.setPartitionHealth({ tenantId, health }) : Promise.resolve(),
      ]);
    } else {
      if (this.adapter.setPartitionHealth) {
        await this.adapter.setPartitionHealth({ tenantId, health });
      }
    }

    return {
      tenantId,
      ok,
      health,
      reason: ok ? undefined : reason,
      ledgerChecksum,
      processingChecksum,
      feeInvariantChecks: {
        clearingRegistryExpectedAccountIds: expectedClearingAccountIds,
        observedCollectionAccounts,
      },
    };
  }

  async reconcileAllTenants(tenantIds: string[]): Promise<PartitionReconciliationResult[]> {
    const results: PartitionReconciliationResult[] = [];
    // High priority: sequential to avoid overwhelming adapters.
    for (const tenantId of tenantIds) {
      results.push(await this.reconcileTenant(tenantId));
    }
    return results;
  }
}

