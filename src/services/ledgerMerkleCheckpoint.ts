import fs from 'fs';
import path from 'path';
import type { HexDigest } from './merkle/types';

export type LedgerCheckpoint = {
  root: HexDigest;
  leafCount: number;
  updatedAt: string;
};

export function getCheckpointPath(): string {
  const repoRoot = path.join(__dirname, '../../');
  return path.join(repoRoot, 'data/ledger-checkpoint.json');
}

export function readCheckpoint(): LedgerCheckpoint | null {
  const checkpointPath = getCheckpointPath();
  try {
    if (!fs.existsSync(checkpointPath)) return null;
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const cp = parsed as LedgerCheckpoint;
    if (typeof cp.root !== 'string') return null;
    if (!Number.isInteger(cp.leafCount)) return null;
    if (typeof cp.updatedAt !== 'string') return null;
    return cp;
  } catch {
    return null;
  }
}

export function writeCheckpoint(cp: LedgerCheckpoint): void {
  const checkpointPath = getCheckpointPath();
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
}

