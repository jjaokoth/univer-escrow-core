import fs from 'fs';
import path from 'path';
import { DatabaseService, type EscrowRecord } from './DatabaseService';
import { AuditLogger } from './AuditLogger';
import { buildMerkleForLedger } from './merkle/ledgerMerkle';
import { MerkleTree } from './merkle/MerkleTree';
import type { HexDigest } from './merkle/types';
import { sha256Hex } from './merkle/sha256';
import { readCheckpoint, writeCheckpoint } from './ledgerMerkleCheckpoint';
import { NotaryAnchorService, type NotaryAuthoritativeState } from './NotaryAnchorService';

export type LedgerCheckpoint = {
  root: HexDigest;
  leafCount: number;
  updatedAt: string;
};

export class LedgerAuditor {
  private static instance: LedgerAuditor | null = null;

  // Internal: do not use this for user-facing audit action labels.
  // AuditLogger expects action union types.


  private timer: NodeJS.Timeout | null = null;
  private frozen = false;

  private readonly checkpointPath: string;
  private readonly ledgerPath: string;

  private latestNotaryState: NotaryAuthoritativeState | null = null;


  private constructor(opts?: { checkpointPath?: string; ledgerPath?: string }) {
    const repoRoot = path.join(__dirname, '../../');
    this.checkpointPath = opts?.checkpointPath ?? path.join(repoRoot, 'data/ledger-checkpoint.json');
    this.ledgerPath = opts?.ledgerPath ?? path.join(repoRoot, 'data/ledger-store.json');
  }

  public static getInstance(): LedgerAuditor {
    if (!LedgerAuditor.instance) LedgerAuditor.instance = new LedgerAuditor();
    return LedgerAuditor.instance;
  }

  public start(params?: { intervalMs?: number }): void {
    const intervalMs = params?.intervalMs ?? 5000;
    if (this.timer) return;

    // One immediate run.
    void this.auditOnce();

    this.timer = setInterval(() => {
      void this.auditOnce();
    }, intervalMs);
  }

  public isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Admin-gated unfreeze entrypoint.
   *
   * IMPORTANT: This method does not perform signature validation. Callers must
   * ensure AdminRecoveryService multi-sig verification + ledger healing has
   * succeeded.
   */
  public async unfreezeIfClean(reason: string): Promise<boolean> {
    if (!this.frozen) return true;


    // Re-run a bounded audit check synchronously.
    // auditOnce() short-circuits if frozen, so we temporarily override.
    const wasFrozen = this.frozen;
    try {
      this.frozen = false;
      await this.auditOnce();

      // auditOnce may freeze again.
      if (this.frozen) {
        void AuditLogger.logEvent({
          tenantId: 'unknown',
          action: 'RELEASE',
          status: 'FAILED',
          error: `LEDGER_UNFREEZE_REJECTED: ${reason}`
        });

        return false;

      }


      // Clear marker file best-effort.
      try {
        fs.unlinkSync(path.join(path.dirname(this.checkpointPath), 'ledger-frozen.marker'));
      } catch {
        // ignore
      }

        void AuditLogger.logEvent({
          tenantId: 'unknown',
          action: 'RELEASE',
          status: 'SUCCESS',

          error: `LEDGER_UNFREEZE_ACCEPTED: ${reason}`
        });



      return true;
    } finally {

      // If audit succeeded, this.frozen is already false.
      // If it failed, auditOnce re-freezes and we keep it.
      if (wasFrozen && !this.frozen) {
        this.frozen = false;
      }
    }
  }


  public freeze(reason: string): void {
    if (this.frozen) return;
    this.frozen = true;

    // Emit CRITICAL audit event.
    void AuditLogger.logEvent({
      tenantId: 'unknown',
      action: 'RELEASE',
      status: 'FAILED',
      error: `LEDGER_FREEZE: ${reason}`
    });

    // Best-effort: create a marker file.
    try {
      fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
      fs.writeFileSync(
        path.join(path.dirname(this.checkpointPath), 'ledger-frozen.marker'),
        JSON.stringify({ reason, at: new Date().toISOString() })
      );
    } catch {
      // ignore
    }
  }

  private readCheckpoint(): LedgerCheckpoint | null {
    try {
      if (!fs.existsSync(this.checkpointPath)) return null;
      const raw = fs.readFileSync(this.checkpointPath, 'utf8');
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return null;
      const cp = parsed as LedgerCheckpoint;
      if (!cp.root || typeof cp.root !== 'string') return null;
      if (!Number.isInteger(cp.leafCount)) return null;
      if (!cp.updatedAt || typeof cp.updatedAt !== 'string') return null;
      return cp;
    } catch {
      return null;
    }
  }

  private async auditOnce(): Promise<void> {
    if (this.frozen) return;

    const checkpoint = this.readCheckpoint();
    if (!checkpoint) {
      // If no checkpoint exists yet, establish one from current ledger.
      const records = await DatabaseService.getAllRecords();
      const { root, tree } = buildMerkleForLedger(records);
      const leafCount = tree.getLeafCount();
      this.writeCheckpoint({ root, leafCount, updatedAt: new Date().toISOString() });
      return;
    }

    // 1) Dual-root verification: local checkpoint vs notary authoritative state (fail-closed).
    // Any inability to verify against distributed notary consensus is treated as an active consensus disruption.
    const notary = NotaryAnchorService.getInstance();
    try {
      const remoteState = await notary.fetchAuthoritativeState();
      this.latestNotaryState = remoteState;

      if (remoteState.root !== checkpoint.root) {
        this.freeze(
          `State-omission/checkpoint-override detected: localRoot!=notaryRoot (seq=${remoteState.sequenceNumber})`
        );
        return;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'remote_notary_unavailable';
      this.freeze(`EMERGENCY_SYSTEM_FREEZE: Remote consensus unreachable. Reason=${msg}`);
      return;
    }


    let rawRecords: EscrowRecord[] = [];
    try {
      const raw = fs.readFileSync(this.ledgerPath, { encoding: 'utf8' });
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) {
        this.freeze('Ledger store file is corrupted or not an array');
        return;
      }

      // Validate records using DatabaseService type guards by re-using getAllRecords.
      rawRecords = await DatabaseService.getAllRecords();
    } catch {
      this.freeze('Unable to read ledger store from disk');
      return;
    }

    const { root: recomputedRoot, tree } = buildMerkleForLedger(rawRecords);

    if (tree.getLeafCount() !== checkpoint.leafCount) {
      this.freeze(
        `Ledger tamper detected: leafCount mismatch (expected ${checkpoint.leafCount}, got ${tree.getLeafCount()})`
      );
      return;
    }

    if (recomputedRoot !== checkpoint.root) {
      // Produce a compact mismatch fingerprint.
      const mismatchFingerprint = sha256Hex(`AUDIT_MISMATCH|${checkpoint.root}|${recomputedRoot}`);
      this.freeze(`Ledger tamper detected: root mismatch. fp=${mismatchFingerprint}`);
      return;
    }

    // Match: no-op.
  }

  private writeCheckpoint(cp: LedgerCheckpoint): void {
    try {
      fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
      fs.writeFileSync(this.checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
    } catch {
      // If checkpoint can’t be written, auditor will freeze on next mismatch.
    }
  }

  /**
   * Used by DatabaseService to update the active application checkpoint.
   */
  public updateCheckpointNow(root: HexDigest, leafCount: number): void {
    // 1) Always persist local checkpoint.
    const localUpdatedAt = new Date().toISOString();
    this.writeCheckpoint({ root, leafCount, updatedAt: localUpdatedAt });

    // 2) Broadcast to external notary layer best-effort.
    // Do not freeze here: verification loop will freeze on mismatch.
    void NotaryAnchorService.getInstance()
      .broadcastRootAnchor({ root, leafCount, localUpdatedAt })
      .then(() => {
        // no-op; auditor loop will cache authoritative state
      })
      .catch(() => {
        // ignore network failures
      });
  }

  public async getLatestNotaryAttestationForLocalCheckpointRoot(): Promise<NotaryAuthoritativeState | null> {
    if (this.latestNotaryState && this.latestNotaryState.root === this.readCheckpoint()?.root) {
      return this.latestNotaryState;
    }

    try {
      const s = await NotaryAnchorService.getInstance().fetchAuthoritativeState();
      this.latestNotaryState = s;
      return s;
    } catch {
      return this.latestNotaryState;
    }
  }
}


