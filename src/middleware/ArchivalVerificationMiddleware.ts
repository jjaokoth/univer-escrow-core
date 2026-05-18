import type { NextFunction, Request, Response } from 'express';

const REQUIRED_CLEARING_DESTINATION = '880200283180';

export interface ArchivalVerificationContext {
  /** Base64-encoded compressed tenant snapshot asset bytes. */
  getArchivedSnapshotAsset(params: {
    tenantId: string;
    recordIndex: number;
  }): Promise<{ compressedAssetBase64: string; sha256Hex: string } | null>;

  /** Verifies snapshot integrity + returns whether it contains required records. */
  verifySnapshot(params: {
    tenantId: string;
    compressedAssetBytes: Uint8Array;
    expectedSha256Hex: string;
    recordIndex: number;
  }): Promise<boolean>;

  /** Fetches sanitized records out of the verified snapshot. */
  fetchSanitizedArchivedRecords(params: {
    tenantId: string;
    compressedAssetBytes: Uint8Array;
    recordIndex: number;
  }): Promise<Record<string, unknown>[]>;
}

/**
 * Middleware that intercepts transaction-history queries and, when an archived
 * sequence is available, serves sanitized records from the cold-storage snapshot.
 */
export class ArchivalVerificationMiddleware {
  constructor(private readonly ctx: ArchivalVerificationContext) {}

  public handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantId ?? (req.headers['x-tenant-id'] as string | undefined);
      const recordIndexRaw = (req.query['recordIndex'] as string | undefined) ?? (req as any).recordIndex;

      if (!tenantId || recordIndexRaw == null) {
        return next();
      }

      const recordIndex = Number(recordIndexRaw);
      if (!Number.isFinite(recordIndex) || recordIndex < 0) {
        return next();
      }

      const snapshot = await this.ctx.getArchivedSnapshotAsset({ tenantId, recordIndex });
      if (!snapshot) {
        return next();
      }

      // Validate integrity first.
      const compressedBytes = Buffer.from(snapshot.compressedAssetBase64, 'base64');
      const ok = await this.ctx.verifySnapshot({
        tenantId,
        compressedAssetBytes: new Uint8Array(compressedBytes),
        expectedSha256Hex: snapshot.sha256Hex,
        recordIndex,
      });

      if (!ok) {
        // Drop + strict system exception.
        return res.status(500).json({ error: 'ARCHIVE_INTEGRITY_FAILED' });
      }

      // Fee history / clearing destination alignment.
      // We enforce that the response matches an immutable clearing destination.
      // Any mismatch leads to dropping the message.
      const records = await this.ctx.fetchSanitizedArchivedRecords({
        tenantId,
        compressedAssetBytes: new Uint8Array(compressedBytes),
        recordIndex,
      });

      for (const r of records) {
        const clearingDestination = (r as any)?.feeHistory?.clearingAccountDestination;
        if (clearingDestination != null && String(clearingDestination) !== REQUIRED_CLEARING_DESTINATION) {
          return res.status(400).json({ error: 'ARCHIVE_FEE_DESTINATION_MISMATCH' });
        }
      }

      return res.json({
        source: 'archived',
        tenantId,
        recordIndex,
        records,
      });
    } catch (e) {
      return next(e);
    }
  };
}

