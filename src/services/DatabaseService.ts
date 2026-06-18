import fs from 'fs';
import path from 'path';
import { LedgerAuditor } from './LedgerAuditor';
import { buildMerkleForLedger } from './merkle/ledgerMerkle';
import { EnclaveSealingEngine, type EnclaveSealingConfig } from './cryptography/EnclaveSealingEngine.js';

export type EscrowStatus = 'LOCKED' | 'RELEASED' | 'FAILED';

export interface EscrowRecord {
  transactionId: string;
  /** Blind commitment of sensitive fields. */
  escrowRecordLeafHash: string;
  signature: string;
  status: EscrowStatus;
  /** Time-lock constraint: transaction is valid at/after this time (ms since epoch). */
  validAfterMs: number;
  /** Time-lock constraint: transaction is valid before this time (ms since epoch). */
  validUntilMs: number;
  /** Local persistence timestamp (not trusted for legality checks). */
  timestamp: string;
}


type LedgerStore = EscrowRecord[];

export type CommitmentInputs = {
  tenantId: string;
  account: string;
  amount: number;
  /** Client/enclave-generated blinding salt. Must never be persisted. */
  blindingSalt: string;
};

export class DatabaseService {
  private static storeInitialized = false;
  private static initLock: Promise<void> | null = null;

  // Keep writes thread-safe within a single Node.js process.
  private static writeQueue: Promise<void> = Promise.resolve();

  // data/ledger-store.json at repo root.
  private static readonly storePath = path.join(
    __dirname,
    '../../data/ledger-store.json'
  );

  private static readonly storeDirPath = path.dirname(
    DatabaseService.storePath
  );

  private static activeSealingContext: EnclaveSealingConfig | null = null;
  private static activeSealingEngine: EnclaveSealingEngine | null = null;

  private static async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = DatabaseService.writeQueue.then(fn, fn);
    // Ensure the queue always advances.
    DatabaseService.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private static async initializeStore(): Promise<void> {
    if (DatabaseService.storeInitialized) return;

    if (DatabaseService.initLock) {
      await DatabaseService.initLock;
      return;
    }

    DatabaseService.initLock = (async () => {
      try {
        fs.mkdirSync(DatabaseService.storeDirPath, { recursive: true });
      } catch (err) {
        // If directory creation fails due to permissions, allow downstream to surface.
        throw err;
      }

      try {
        if (!fs.existsSync(DatabaseService.storePath)) {
          fs.writeFileSync(DatabaseService.storePath, JSON.stringify([]), 'utf8');
        } else {
          // Validate JSON shape; if invalid, reset to empty array.
          const raw = fs.readFileSync(DatabaseService.storePath, 'utf8');
          if (!raw.trim()) {
            fs.writeFileSync(DatabaseService.storePath, JSON.stringify([]), 'utf8');
            return;
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
              fs.writeFileSync(DatabaseService.storePath, JSON.stringify([]), 'utf8');
            }
          } catch {
            fs.writeFileSync(DatabaseService.storePath, JSON.stringify([]), 'utf8');
          }
        }
      } catch (err) {
        throw err;
      } finally {
        DatabaseService.storeInitialized = true;
      }
    })();

    await DatabaseService.initLock;
  }

  public static setActiveSealingContext(config: EnclaveSealingConfig): void {
    if (!config || typeof config !== 'object') {
      throw new TypeError('config must be an EnclaveSealingConfig object');
    }

    DatabaseService.activeSealingContext = {
      cpuMasterSecret: String(config.cpuMasterSecret),
      mrsigner: String(config.mrsigner),
      mrenclave: String(config.mrenclave)
    };
    DatabaseService.activeSealingEngine = new EnclaveSealingEngine(
      DatabaseService.activeSealingContext
    );
  }

  public static getActiveSealingContext(): EnclaveSealingConfig | null {
    if (!DatabaseService.activeSealingContext) return null;
    return {
      cpuMasterSecret: DatabaseService.activeSealingContext.cpuMasterSecret,
      mrsigner: DatabaseService.activeSealingContext.mrsigner,
      mrenclave: DatabaseService.activeSealingContext.mrenclave
    };
  }

  public static getActiveSealingEngine(): EnclaveSealingEngine | null {
    if (!DatabaseService.activeSealingEngine && DatabaseService.activeSealingContext) {
      DatabaseService.activeSealingEngine = new EnclaveSealingEngine(
        DatabaseService.activeSealingContext
      );
    }
    return DatabaseService.activeSealingEngine;
  }

  public static async saveRecord(record: EscrowRecord): Promise<void> {
    if (!record || typeof record !== 'object') {
      throw new TypeError('record must be an EscrowRecord object');
    }

    await DatabaseService.initializeStore();

    // Ensure atomicity for appends/updates within one process.
    await DatabaseService.withWriteLock(async () => {
      try {
        const existing = await DatabaseService.readAllRecordsInternal();

        const idx = existing.findIndex(
          (r) => r.transactionId === record.transactionId
        );

        const normalized: EscrowRecord = {
          transactionId: String(record.transactionId),
          // Only blind commitment leaf hash is persisted; no cleartext parameters.
          escrowRecordLeafHash: String(record.escrowRecordLeafHash),
          signature: String(record.signature),
          status: record.status,
          validAfterMs: record.validAfterMs,
          validUntilMs: record.validUntilMs,
          timestamp: String(record.timestamp)
        };

        if (idx >= 0) {
          existing[idx] = normalized;
        } else {
          existing.push(normalized);
        }

        const data = JSON.stringify(existing, null, 2);

        // Atomic-ish replace: write temp file, then rename.
        const tmpPath = `${DatabaseService.storePath}.tmp`;
        fs.writeFileSync(tmpPath, data, { encoding: 'utf8', flag: 'w' });
        fs.renameSync(tmpPath, DatabaseService.storePath);

        // Immediately update the active checkpoint root.
        const { root, tree } = buildMerkleForLedger(existing);
        LedgerAuditor.getInstance().updateCheckpointNow(root, tree.getLeafCount());
      } catch (err) {
        // Best-effort recovery: remove temp file.
        try {
          const tmpPath = `${DatabaseService.storePath}.tmp`;
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
        throw err;
      }
    });
  }

  public static async getRecord(
    transactionId: string
  ): Promise<EscrowRecord | null> {
    try {
      await DatabaseService.initializeStore();
      const records = await DatabaseService.readAllRecordsInternal();
      const found = records.find((r) => r.transactionId === transactionId);
      return found ?? null;
    } catch {
      return null;
    }
  }

  public static async getAllRecords(): Promise<EscrowRecord[]> {
    try {
      await DatabaseService.initializeStore();
      return await DatabaseService.readAllRecordsInternal();
    } catch {
      return [];
    }
  }

  private static async readAllRecordsInternal(): Promise<LedgerStore> {
    // Synchronous reads avoid torn reads within this process while writes are queued.
    const raw = fs.readFileSync(DatabaseService.storePath, { encoding: 'utf8' });
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed)) return [];

    // Type guard / normalization.
    const out: EscrowRecord[] = [];
    for (const item of parsed) {
      const maybe = item as Partial<EscrowRecord>;
      if (
        typeof maybe?.transactionId === 'string' &&
        typeof (maybe as any)?.escrowRecordLeafHash === 'string' &&
        typeof maybe?.signature === 'string' &&
        (maybe?.status === 'LOCKED' ||
          maybe?.status === 'RELEASED' ||
          maybe?.status === 'FAILED') &&
        typeof (maybe as any)?.validAfterMs === 'number' &&
        Number.isFinite((maybe as any)?.validAfterMs) &&
        typeof (maybe as any)?.validUntilMs === 'number' &&
        Number.isFinite((maybe as any)?.validUntilMs) &&
        typeof maybe?.timestamp === 'string'
      ) {
        out.push(maybe as EscrowRecord);
      }
    }
    return out;
  }
}

