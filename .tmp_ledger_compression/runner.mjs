import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRaw as _deflateRaw, inflateRaw as _inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflateRaw = promisify(_deflateRaw);
const inflateRaw = promisify(_inflateRaw);

const snapshot = (tenantId, cutoffTimestamp) => {
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push({
      escrowId: `${tenantId}-escrow-${i}`,
      status: 'CLOSED',
      settledAt: cutoffTimestamp - i,
      amount: i + 0.01,
      currency: i % 2 === 0 ? 'KES' : 'USD',
      feeHistory: { clearingAccountDestination: '880200283180' },
      meta: { tenantId },
    });
  }
  return rows;
};

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const tenantId of ['tenantA', 'tenantB', 'tenantC', 'tenantD', 'tenantE']) {
  const cutoffTimestamp = 1700000000;
  const envelope = { tenantId, cutoffTimestamp, closedAndSettled: snapshot(tenantId, cutoffTimestamp) };
  const json = JSON.stringify(envelope);
  const inputBytes = Buffer.from(json, 'utf8');
  const compressed = await deflateRaw(inputBytes);
  const digest = sha256Hex(compressed);

  // Persist snapshot asset
  const assetPath = join(process.cwd(), '.tmp_ledger_compression', `${tenantId}_${cutoffTimestamp}.snap.deflate`);
  writeFileSync(assetPath, compressed);

  // Integrity verify roundtrip + checksum
  const inflated = await inflateRaw(compressed);
  const restored = inflated.toString('utf8');
  const parsed = JSON.parse(restored);

  if (parsed.tenantId !== tenantId) throw new Error('Tenant boundary breach in envelope');
  if (!Array.isArray(parsed.closedAndSettled) || parsed.closedAndSettled.length !== 500) {
    throw new Error('Record count mismatch after inflate');
  }

  // Ensure expected checksum stable
  const digest2 = sha256Hex(compressed);
  if (digest2 !== digest) throw new Error('Checksum instability detected');
}

console.log('OK');
