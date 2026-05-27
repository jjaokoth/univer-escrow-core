import crypto from 'crypto';
import type { HexDigest } from './types';

export function sha256Hex(data: Uint8Array | string): HexDigest {
  const h = crypto.createHash('sha256');
  if (typeof data === 'string') {
    h.update(Buffer.from(data, 'utf8'));
  } else {
    h.update(Buffer.from(data));
  }
  return h.digest('hex') as HexDigest;
}

export function sha256HexFromJsonStable(obj: unknown): HexDigest {
  // Deterministic JSON stringification with stable key order.
  // For our use-case, ledger records are flat primitives.
  const stable = stableStringify(obj);
  return sha256Hex(stable);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
  }
  // Fallback
  return JSON.stringify(value);
}

