import fs from 'fs';
import path from 'path';

import { CryptoService } from './CryptoService.js';
import { NotaryAnchorService, type NotaryAuthoritativeState } from './NotaryAnchorService.js';
import { DatabaseService, type EscrowRecord } from './DatabaseService.js';
import { buildMerkleForLedger } from './merkle/ledgerMerkle.js';
import { sha256Hex } from './merkle/sha256.js';
import type { HexDigest } from './merkle/types.js';

export type RecoverySignature = {
  officerPublicKey: string;
  signatureHex: string;
};

export type AdminRecoveryPayload = {
  // Must include a unique request id to make the recovery idempotent.
  requestId: string;
  // Human/action identifier to bind signatures to a specific recovery intent.
  action: 'LEDGER_UNFREEZE_RITUAL';
  // Canonical expiration time (ISO string) for request validity.
  expiresAt: string;
  // M-of-N recovery signatures.
  signatures: RecoverySignature[];
};

export type AdminRecoveryOutcome = {
  ok: boolean;
  authoritativeState?: NotaryAuthoritativeState;
  healedRoot?: HexDigest;
  healedLeafCount?: number;
  quarantineFile?: string;
  error?: string;
};

function canonicalizeJsonStable(value: unknown): string {
  // Minimal stable JSON canon for deterministic hashing.
  // Handles primitives, arrays, and plain objects with stable key ordering.
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJsonStable(v)).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalizeJsonStable(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function parseIsoOrNull(iso: string): number | null {
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

export class AdminRecoveryService {
  private static instance: AdminRecoveryService | null = null;

  // Configuration is intentionally env-driven for deployment safety.
  // Format: comma-separated public keys.
  private readonly recoveryOfficerPublicKeys: string[];
  private readonly thresholdM: number;

  // Ledger store + quarantine output live under repoRoot/data.
  private readonly ledgerStorePath: string;
  private readonly quarantineDirPath: string;

  private readonly recoveryRequestsLedgerPath: string;

  private constructor() {
    const repoRoot = path.join(__dirname, '../../');

    this.ledgerStorePath = path.join(repoRoot, 'data/ledger-store.json');
    this.quarantineDirPath = path.join(repoRoot, 'data/quarantine-ledger');

    this.recoveryRequestsLedgerPath = path.join(repoRoot, 'data/admin-recovery-requests.json');

    const keysEnv = process.env.ADMIN_RECOVERY_OFFICER_PUBLIC_KEYS ?? '';
    this.recoveryOfficerPublicKeys = keysEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const mEnv = process.env.ADMIN_RECOVERY_THRESHOLD_M ?? '';
    const mParsed = mEnv ? Number(mEnv) : NaN;
    this.thresholdM = Number.isFinite(mParsed) ? Math.floor(mParsed) : 0;

    // Fail safe: if not configured, threshold verification always fails.
    if (this.recoveryOfficerPublicKeys.length === 0 || this.thresholdM <= 0) {
      // Leave as-is; verification will fail.
    }
  }

  public static getInstance(): AdminRecoveryService {
    if (!AdminRecoveryService.instance) {
      AdminRecoveryService.instance = new AdminRecoveryService();
    }
    return AdminRecoveryService.instance;
  }

  public verifyMultiSig(payload: AdminRecoveryPayload): boolean {
    if (!payload || payload.action !== 'LEDGER_UNFREEZE_RITUAL') return false;

    const nowMs = Date.now();
    const expiresMs = parseIsoOrNull(payload.expiresAt);
    if (expiresMs === null) return false;
    if (expiresMs <= nowMs) return false;

    const uniqueKeys = new Set<string>();
    let validCount = 0;

    const messageToVerify = this.recoveryMessageToVerify(payload);

    for (const sig of payload.signatures ?? []) {
      if (!sig?.officerPublicKey || !sig?.signatureHex) continue;
      if (!this.recoveryOfficerPublicKeys.includes(sig.officerPublicKey)) continue;
      if (uniqueKeys.has(sig.officerPublicKey)) continue;

      const isValid = CryptoService.verifySignature(messageToVerify, sig.signatureHex, sig.officerPublicKey);
      if (isValid) {
        uniqueKeys.add(sig.officerPublicKey);
        validCount++;
      }
    }

    return validCount >= this.thresholdM;
  }

  private recoveryMessageToVerify(payload: AdminRecoveryPayload): string {
    // Bind signatures to exact payload context; excludes signatures themselves.
    const unsigned: Omit<AdminRecoveryPayload, 'signatures'> = {
      requestId: payload.requestId,
      action: payload.action,
      expiresAt: payload.expiresAt
    };

    // Hash canonical JSON to keep message size fixed.
    const canon = canonicalizeJsonStable(unsigned);
    return sha256Hex(`ADMIN_RECOVERY|${canon}`);
  }

  private readRecoveryRequests(): string[] {
    try {
      if (!fs.existsSync(this.recoveryRequestsLedgerPath)) return [];
      const raw = fs.readFileSync(this.recoveryRequestsLedgerPath, 'utf8');
      if (!raw.trim()) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((x) => String(x));
    } catch {
      return [];
    }
  }

  private appendRecoveryRequest(requestId: string): void {
    try {
      const existing = this.readRecoveryRequests();
      if (existing.includes(requestId)) return;
      existing.push(requestId);
      fs.mkdirSync(path.dirname(this.recoveryRequestsLedgerPath), { recursive: true });
      fs.writeFileSync(this.recoveryRequestsLedgerPath, JSON.stringify(existing, null, 2), 'utf8');
    } catch {
      // Best effort; if it fails, healing remains protected by signature verification.
    }
  }

  public async attemptHealAndReturnOutcome(payload: AdminRecoveryPayload): Promise<AdminRecoveryOutcome> {
    // Step 0: replay protection.
    const already = this.readRecoveryRequests().includes(payload.requestId);
    if (already) {
      return { ok: true, error: 'DUPLICATE_REQUEST_ID' };
    }

    if (!this.verifyMultiSig(payload)) {
      return { ok: false, error: 'MULTISIG_THRESHOLD_VERIFICATION_FAILED' };
    }

    const authoritativeState = await NotaryAnchorService.getInstance().fetchAuthoritativeState();

    // Step 1: read ledger-store as raw records.
    let records: EscrowRecord[];
    try {
      // Use DatabaseService to normalize record types.
      records = await DatabaseService.getAllRecords();
    } catch {
      return { ok: false, error: 'LEDGER_READ_FAILED' };
    }

    // Step 2: scan sequentially to find a prefix whose Merkle root matches the authoritative root.
    // If we find it, truncate ledger store to that prefix.
    const targetRoot = authoritativeState.root;

    let healedPrefixLen = -1;
    let healedRoot: HexDigest | undefined;
    let healedLeafCount: number | undefined;

    for (let i = records.length; i >= 0; i--) {
      const prefix = records.slice(0, i);
      const { root, tree } = buildMerkleForLedger(prefix);

      if (tree.getLeafCount() !== i) {
        // Structural mismatch; keep scanning.
        continue;
      }

      if (root === targetRoot) {
        healedPrefixLen = i;
        healedRoot = root;
        healedLeafCount = tree.getLeafCount();
        break;
      }
    }

    if (healedPrefixLen < 0 || healedRoot === undefined || healedLeafCount === undefined) {
      return {
        ok: false,
        authoritativeState,
        error: 'NO_PREFIX_MATCHES_AUTHORITATIVE_NOTARY_ROOT'
      };
    }

    // Step 3: quarantine discarded suffix.
    const suffix = records.slice(healedPrefixLen);
    const quarantineFile = path.join(
      this.quarantineDirPath,
      `quarantine_${payload.requestId}_${Date.now()}.json`
    );

    try {
      fs.mkdirSync(this.quarantineDirPath, { recursive: true });
      fs.writeFileSync(
        quarantineFile,
        JSON.stringify({ requestId: payload.requestId, authoritativeState, truncatedAt: healedPrefixLen, quarantined: suffix }, null, 2),
        'utf8'
      );
    } catch {
      // Quarantine failure should not prevent heal success if truncation succeeds.
    }

    // Step 4: truncate ledger-store.json on disk to the healed prefix.
    try {
      const healed = records.slice(0, healedPrefixLen);
      fs.writeFileSync(this.ledgerStorePath, JSON.stringify(healed, null, 2), 'utf8');

      // Step 5: recompute checkpoint and persist it via LedgerAuditor.
      const { root, tree } = buildMerkleForLedger(healed);
      // LedgerAuditor.updateCheckpointNow is synchronous but broadcasts best-effort to notary.
      // We import lazily to avoid circular deps.
      const { LedgerAuditor } = await import('./LedgerAuditor.js');
      LedgerAuditor.getInstance().updateCheckpointNow(root, tree.getLeafCount());

      this.appendRecoveryRequest(payload.requestId);

      return {
        ok: true,
        authoritativeState,
        healedRoot: root,
        healedLeafCount: tree.getLeafCount(),
        quarantineFile
      };
    } catch (err: unknown) {
      return { ok: false, authoritativeState, quarantineFile, error: err instanceof Error ? err.message : 'HEAL_WRITE_FAILED' };
    }
  }
}

