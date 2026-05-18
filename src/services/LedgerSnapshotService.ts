/******************************************************
 * LedgerSnapshotService.ts
 * ----------------------------------------------------
 * Tenant-scoped ledger snapshot compilation +
 * tenant-isolated cold storage export.
 ******************************************************/

import { createHash } from 'crypto';
import { promisify } from 'util';
import { deflateRaw as _deflateRaw, inflateRaw as _inflateRaw } from 'zlib';

const deflateRaw = promisify(_deflateRaw);
const inflateRaw = promisify(_inflateRaw);

export type LedgerRowLike = Record<string, unknown>;

export interface ColdStorageExporter {
  /** Writes the snapshot asset to the provided absolute or relative file path. */
  writeAsset(filePath: string, bytes: Uint8Array): Promise<void>;
}

export interface LedgerRowProvider {
  /**
   * Returns rows representing closed+settled escrow/ledger entries.
   * Must enforce tenant scoping at the data source.
   */
  fetchClosedSettledRows(params: {
    tenantId: string;
    cutoffTimestamp: number;
  }): Promise<LedgerRowLike[]>;
}

export interface SnapshotCompilationResult {
  tenantId: string;
  cutoffTimestamp: number;
  assetPath: string;
  compressedBytesBase64: string;
  sha256Hex: string;
  recordCount: number;
}

export interface LedgerSnapshotServiceConfig {
  coldStorageBasePath: string;
  exporter: ColdStorageExporter;
  rowProvider: LedgerRowProvider;
  /**
   * When true, verifies checksums after compression.
   * Default: true.
   */
  verifyByDefault?: boolean;
}

export class LedgerSnapshotService {
  private readonly exporter: ColdStorageExporter;
  private readonly rowProvider: LedgerRowProvider;
  private readonly coldStorageBasePath: string;
  private readonly verifyByDefault: boolean;

  constructor(config: LedgerSnapshotServiceConfig) {
    this.exporter = config.exporter;
    this.rowProvider = config.rowProvider;
    this.coldStorageBasePath = config.coldStorageBasePath;
    this.verifyByDefault = config.verifyByDefault ?? true;
  }

  /**
   * Compiles a tenant-scoped snapshot and writes it to cold storage.
   * Compression format:
   * - JSON -> UTF-8 bytes
   * - deflateRaw
   * - checksum computed over compressed bytes
   */
  public async compileTenantSnapshot(params: {
    tenantId: string;
    cutoffTimestamp: number;
  }): Promise<SnapshotCompilationResult> {
    const { tenantId, cutoffTimestamp } = params;

    const rows = await this.rowProvider.fetchClosedSettledRows({
      tenantId,
      cutoffTimestamp,
    });

    // Tenant isolation hardening: snapshot envelope includes tenantId.
    const envelope = {
      tenantId,
      cutoffTimestamp,
      closedAndSettled: rows,
    };

    const json = JSON.stringify(envelope);
    const inputBytes = Buffer.from(json, 'utf8');

    const compressedBytes = await deflateRaw(inputBytes);
    const sha256Hex = this.sha256Hex(compressedBytes);

    if (this.verifyByDefault) {
      await this.verifySnapshotIntegrity({
        compressedBytes,
        expectedSha256Hex: sha256Hex,
      });

      // Also validate decompression restores valid JSON.
      const inflated = await inflateRaw(compressedBytes);
      const restoredJson = inflated.toString('utf8');
      JSON.parse(restoredJson);
    }

    const assetPath = this.buildAssetPath({
      tenantId,
      cutoffTimestamp,
    });

    await this.exporter.writeAsset(assetPath, compressedBytes);

    return {
      tenantId,
      cutoffTimestamp,
      assetPath,
      compressedBytesBase64: Buffer.from(compressedBytes).toString('base64'),
      sha256Hex,
      recordCount: rows.length,
    };
  }

  /**
   * Validates the cryptographic checksum of the compressed snapshot bytes.
   * This method is intended to be called before flushing hot memory.
   */
  public async verifySnapshotIntegrity(params: {
    compressedBytes: Uint8Array;
    expectedSha256Hex: string;
  }): Promise<boolean> {
    const actual = this.sha256Hex(params.compressedBytes);
    if (actual !== params.expectedSha256Hex) {
      throw new Error(
        `Snapshot integrity failure: sha256 mismatch (expected=${params.expectedSha256Hex}, actual=${actual})`,
      );
    }
    return true;
  }

  private sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  private buildAssetPath(params: {
    tenantId: string;
    cutoffTimestamp: number;
  }): string {
    const safeTenant = params.tenantId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `${this.coldStorageBasePath}/tenant_${safeTenant}/ledger_snapshot_${params.cutoffTimestamp}.snap.deflate`;
  }
}

