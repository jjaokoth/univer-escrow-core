/*
 * Univer-Escrow — ReconciliationEngine
 *
 * Administrative safety engine:
 * - Detect balance drift between downstream vendor logs and internal escrow ledgers.
 * - Cross-examine internal recorded values against immutable state ledger snapshots.
 * - If mismatch is detected, flag state as AUDIT_MISMATCH and suspend release automation.
 */

export type EscrowStateLifecycle = 'PENDING' | 'LOCKED' | 'DISPUTED' | 'RELEASED' | 'REFUNDED';

export type StateLedgerEntry = {
  ledgerEntryId: string;
  escrowId: string;
  tenantId: string;
  fromState: EscrowStateLifecycle;
  toState: EscrowStateLifecycle;
  // Immutable transition snapshot values (host-defined). Must be numeric and non-negative.
  inwardValue?: number;
  outValue?: number;
  transitionAt: string;
  mutationIntegrityHash?: string;
};

export type EscrowRecord = {
  tenantId: string;
  escrowId: string;
  state: EscrowStateLifecycle;
  totalAmount: number;
  surchargeAmount: number;
  finalAmount: number;
  updatedAt: string;
};

export type VendorBalanceObservation = {
  tenantId: string;
  escrowId: string;
  vendorId: string;
  // Total inward captured from vendor logs in the window.
  observedInwardTotal: number;
  // Optional signature/validation token for audit.
  signatureOk?: boolean;
};

export type ReconciliationResult = {
  tenantId: string;
  escrowId: string;
  ok: boolean;
  reason?: string;
  internalInwardTotal: number;
  observedInwardTotal: number;
};

export type ReconciliationDataAdapter = {
  // Fetch escrow within window.
  fetchEscrows: (args: { tenantId?: string; windowStart: string; windowEnd: string }) => Promise<EscrowRecord[]>;
  // Fetch immutable ledger entries for escrow.
  fetchLedgerEntries: (args: { tenantId: string; escrowId: string }) => Promise<StateLedgerEntry[]>;
  // Fetch vendor totals for escrow.
  fetchVendorObservations: (args: { tenantId: string; escrowId: string }) => Promise<VendorBalanceObservation[]>;
  // Host persists reconciliation status.
  flagEscrowAuditMismatch: (args: { tenantId: string; escrowId: string; reason: string }) => Promise<void>;
  // Host suspends any automated release state changes.
  suspendReleaseAutomation: (args: { tenantId: string; escrowId: string }) => Promise<void>;
};

export type ReconciliationEngineConfig = {
  adapter: ReconciliationDataAdapter;
  // Drift tolerance in absolute currency units.
  driftTolerance?: number;
};

function sumNonNegative(nums: Array<number | undefined>): number {
  let s = 0;
  for (const n of nums) {
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    if (n < 0) continue;
    s += n;
  }
  return s;
}

export class ReconciliationEngine {
  private readonly adapter: ReconciliationDataAdapter;
  private readonly driftTolerance: number;

  constructor(cfg: ReconciliationEngineConfig) {
    if (!cfg?.adapter) throw new Error('ReconciliationEngine.adapter_REQUIRED');
    this.adapter = cfg.adapter;
    this.driftTolerance = cfg.driftTolerance ?? 0;
  }

  /**
   * Reconcile escrows in a time window.
   */
  async reconcileWindow(args: { tenantId?: string; windowStart: string; windowEnd: string }): Promise<ReconciliationResult[]> {
    const escrows = await this.adapter.fetchEscrows(args);

    const results: ReconciliationResult[] = [];
    for (const escrow of escrows) {
      const res = await this.reconcileEscrow(escrow.tenantId, escrow.escrowId);
      results.push(res);
    }
    return results;
  }

  /**
   * Reconcile a single escrow by comparing:
   * - Internal ledger inward sum across immutable state_ledger entries
   * - Vendor observations observedInwardTotal
   *
   * If mismatch detected => AUDIT_MISMATCH + suspend release automation.
   */
  async reconcileEscrow(tenantId: string, escrowId: string): Promise<ReconciliationResult> {
    const ledger = await this.adapter.fetchLedgerEntries({ tenantId, escrowId });
    const vendorObs = await this.adapter.fetchVendorObservations({ tenantId, escrowId });

    const internalInwardTotal = sumNonNegative(ledger.map((e) => e.inwardValue));
    const observedInwardTotal = sumNonNegative(vendorObs.map((v) => v.observedInwardTotal));

    // Basic invariants
    if (!ledger.length) {
      const reason = 'AUDIT_MISMATCH: NO_LEDGER_ENTRIES';
      await this.flagAndSuspend(tenantId, escrowId, reason);
      return {
        tenantId,
        escrowId,
        ok: false,
        reason,
        internalInwardTotal,
        observedInwardTotal,
      };
    }

    const drift = Math.abs(internalInwardTotal - observedInwardTotal);
    const ok = drift <= this.driftTolerance;

    if (!ok) {
      const reason = `AUDIT_MISMATCH: INWARD_DRIFT=${drift}`;
      await this.flagAndSuspend(tenantId, escrowId, reason);
      return {
        tenantId,
        escrowId,
        ok: false,
        reason,
        internalInwardTotal,
        observedInwardTotal,
      };
    }

    // Optional signatureOk checks
    const anySigBad = vendorObs.some((v) => v.signatureOk === false);
    if (anySigBad) {
      const reason = 'AUDIT_MISMATCH: VENDOR_SIGNATURE_MISMATCH';
      await this.flagAndSuspend(tenantId, escrowId, reason);
      return {
        tenantId,
        escrowId,
        ok: false,
        reason,
        internalInwardTotal,
        observedInwardTotal,
      };
    }

    return {
      tenantId,
      escrowId,
      ok: true,
      internalInwardTotal,
      observedInwardTotal,
    };
  }

  private async flagAndSuspend(tenantId: string, escrowId: string, reason: string): Promise<void> {
    await this.adapter.flagEscrowAuditMismatch({ tenantId, escrowId, reason });
    await this.adapter.suspendReleaseAutomation({ tenantId, escrowId });
  }
}

