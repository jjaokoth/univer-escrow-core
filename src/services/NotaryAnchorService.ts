import fs from 'fs';
import path from 'path';
import { sha256Hex } from './merkle/sha256';
import type { HexDigest } from './merkle/types';

export type NotaryWitnessSignature = {
  witnessId: string;
  signature: string;
};

export type NotaryBroadcastRequest = {
  root: HexDigest;
  leafCount: number;
  localUpdatedAt: string;
};

export type NotaryBroadcastResponse = {
  sequenceNumber: number;
  anchoringTimestamp: string;
  witnessSignatures: NotaryWitnessSignature[];
  root: HexDigest;
};

export type NotaryAuthoritativeState = {
  sequenceNumber: number;
  anchoringTimestamp: string;
  witnessSignatures: NotaryWitnessSignature[];
  root: HexDigest;
};

type NotaryNetworkAdapter = {
  postAnchor: (req: NotaryBroadcastRequest) => Promise<NotaryBroadcastResponse>;
  getAuthoritativeState: () => Promise<NotaryAuthoritativeState>;
};

class HttpNotaryNetworkAdapter implements NotaryNetworkAdapter {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(opts: { baseUrl: string; requestTimeoutMs?: number }) {
    this.baseUrl = opts.baseUrl;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 2500;
  }

  public async postAnchor(reqBody: NotaryBroadcastRequest): Promise<NotaryBroadcastResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const resp = await fetch(`${this.baseUrl}/notary/anchor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      });

      if (!resp.ok) {
        throw new Error(`Notary anchor POST failed: ${resp.status}`);
      }

      const parsed: unknown = await resp.json();
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid notary broadcast response');

      const r = parsed as Partial<NotaryBroadcastResponse>;
      if (!r.root || typeof r.root !== 'string') throw new Error('Invalid notary response: root');
      if (!Number.isInteger(r.sequenceNumber)) throw new Error('Invalid notary response: sequenceNumber');
      if (!r.anchoringTimestamp || typeof r.anchoringTimestamp !== 'string') {
        throw new Error('Invalid notary response: anchoringTimestamp');
      }
      if (!Array.isArray(r.witnessSignatures)) throw new Error('Invalid notary response: witnessSignatures');

      const ws: NotaryWitnessSignature[] = r.witnessSignatures.map((x: any) => ({
        witnessId: String(x?.witnessId ?? ''),
        signature: String(x?.signature ?? '')
      }));

      return {
        root: r.root as HexDigest,
        sequenceNumber: r.sequenceNumber as number,
        anchoringTimestamp: r.anchoringTimestamp as string,
        witnessSignatures: ws
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  public async getAuthoritativeState(): Promise<NotaryAuthoritativeState> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const resp = await fetch(`${this.baseUrl}/notary/state`, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal
      });

      if (!resp.ok) {
        throw new Error(`Notary state GET failed: ${resp.status}`);
      }

      const parsed: unknown = await resp.json();
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid notary authoritative state');

      const s = parsed as Partial<NotaryAuthoritativeState>;
      if (!s.root || typeof s.root !== 'string') throw new Error('Invalid notary response: root');
      if (!Number.isInteger(s.sequenceNumber)) throw new Error('Invalid notary response: sequenceNumber');
      if (!s.anchoringTimestamp || typeof s.anchoringTimestamp !== 'string') {
        throw new Error('Invalid notary response: anchoringTimestamp');
      }
      if (!Array.isArray(s.witnessSignatures)) throw new Error('Invalid notary response: witnessSignatures');

      const ws: NotaryWitnessSignature[] = s.witnessSignatures.map((x: any) => ({
        witnessId: String(x?.witnessId ?? ''),
        signature: String(x?.signature ?? '')
      }));

      return {
        root: s.root as HexDigest,
        sequenceNumber: s.sequenceNumber as number,
        anchoringTimestamp: s.anchoringTimestamp as string,
        witnessSignatures: ws
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class NotaryAnchorService {
  private static instance: NotaryAnchorService | null = null;

  private readonly adapter: NotaryNetworkAdapter;
  private readonly cachePath: string;

  private latestInMemory: NotaryAuthoritativeState | null = null;
  private cacheLoaded = false;

  private constructor(opts?: { baseUrl?: string; cachePath?: string }) {
    const repoRoot = path.join(__dirname, '../../');
    const baseUrl = opts?.baseUrl ?? process.env.NOTARY_ENDPOINT_BASE_URL ?? 'http://localhost:8099';
    const cacheFile = opts?.cachePath ?? path.join(repoRoot, 'data/notary-authoritative-cache.json');

    this.adapter = new HttpNotaryNetworkAdapter({ baseUrl });
    this.cachePath = cacheFile;
  }

  public static getInstance(): NotaryAnchorService {
    if (!NotaryAnchorService.instance) {
      NotaryAnchorService.instance = new NotaryAnchorService();
    }
    return NotaryAnchorService.instance;
  }

  public async broadcastRootAnchor(req: NotaryBroadcastRequest): Promise<void> {
    // Broadcast best-effort; do not freeze from network failures here.
    const resp = await this.adapter.postAnchor(req);
    this.latestInMemory = {
      sequenceNumber: resp.sequenceNumber,
      anchoringTimestamp: resp.anchoringTimestamp,
      witnessSignatures: resp.witnessSignatures,
      root: resp.root
    };
    this.persistCache(this.latestInMemory);
  }

  public async fetchAuthoritativeState(): Promise<NotaryAuthoritativeState> {
    await this.loadCacheIfNeeded();

    // Fail-closed policy with bounded retries.
    // If remote cannot be reached/verified, callers must treat it as an emergency consensus boundary violation.
    const maxAttempts = 3;
    const retryDelayMs = 1000;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const s = await this.adapter.getAuthoritativeState();
        this.latestInMemory = s;
        this.persistCache(s);
        return s;
      } catch (err: unknown) {
        lastErr = err;
        // Best-effort: do not freeze here (avoid circular dependency). Freeze is enforced by LedgerAuditor.
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }

    throw new Error('No authoritative notary state available: remote unreachable');
  }

  public async getLatestCachedAuthoritativeState(): Promise<NotaryAuthoritativeState | null> {
    await this.loadCacheIfNeeded();
    return this.latestInMemory;
  }

  private persistCache(s: NotaryAuthoritativeState): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const fp = sha256Hex(JSON.stringify(s));
      fs.writeFileSync(
        this.cachePath,
        JSON.stringify({ ...s, _cacheFingerprint: fp, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }
  }

  private readCache(): NotaryAuthoritativeState | null {
    try {
      if (!fs.existsSync(this.cachePath)) return null;
      const raw = fs.readFileSync(this.cachePath, 'utf8');
      if (!raw.trim()) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const s = parsed as any;

      if (!s.root || typeof s.root !== 'string') return null;
      if (!Number.isInteger(s.sequenceNumber)) return null;
      if (!s.anchoringTimestamp || typeof s.anchoringTimestamp !== 'string') return null;
      if (!Array.isArray(s.witnessSignatures)) return null;

      return {
        root: s.root as HexDigest,
        sequenceNumber: s.sequenceNumber as number,
        anchoringTimestamp: s.anchoringTimestamp as string,
        witnessSignatures: (s.witnessSignatures as any[]).map((x) => ({
          witnessId: String(x?.witnessId ?? ''),
          signature: String(x?.signature ?? '')
        }))
      };
    } catch {
      return null;
    }
  }

  private async loadCacheIfNeeded(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    const c = this.readCache();
    this.latestInMemory = c;
  }
}

