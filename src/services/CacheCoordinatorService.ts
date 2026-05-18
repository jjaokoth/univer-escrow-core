/*
 * Univer-Escrow — CacheCoordinatorService
 *
 * Purpose:
 * - High-speed in-memory, tenant-namespaced caching coordinator.
 * - Strict key namespacing: tenant::[tenantId]::config::[key]
 * - TTL-based expiration to force periodic refresh.
 * - Atomic get/set operations.
 */

export type CacheCoordinatorConfig = {
  ttlSeconds?: number; // default 300
  maxEntries?: number; // simple guard
};

type CacheEntry = {
  value: string; // cached strings only (spec: frequently accessed config parameters)
  expiresAtMs: number;
};

function nowMs(): number {
  return Date.now();
}

function buildTenantConfigKey(tenantId: string, key: string): string {
  // Enforce strict structure; reject empty segments.
  finalTrimCheck(tenantId, 'tenantId');
  finalTrimCheck(key, 'key');
  // Prevent delimiter smuggling by stripping reserved characters.
  const safeTenant = tenantId.replaceAll('::', ':');
  const safeKey = key.replaceAll('::', ':');
  return `tenant::${safeTenant}::config::${safeKey}`;
}

function finalTrimCheck(v: string, name: string) {
  if (v.trim().length === 0) throw new Error(`CacheCoordinatorService.${name}_REQUIRED`);
}


export class CacheCoordinatorService {
  private readonly ttlSeconds: number;
  private readonly maxEntries: number;

  private readonly store = new Map<string, CacheEntry>();

  constructor(cfg: CacheCoordinatorConfig = {}) {
    this.ttlSeconds = cfg.ttlSeconds ?? 300;
    this.maxEntries = cfg.maxEntries ?? 50_000;
  }

  /**
   * Returns cached config value as string, or null if missing/expired.
   */
  async getCachedConfig(tenantId: string, key: string): Promise<string | null> {

    const namespaced = buildTenantConfigKey(tenantId, key);

    const entry = this.store.get(namespaced);
    if (!entry) return null;

    if (entry.expiresAtMs <= nowMs()) {
      this.store.delete(namespaced);
      return null;
    }

    return entry.value;
  }

  /**
   * Stores cached config string value under the strict tenant namespace.
   */
  async setCachedConfig(tenantId: string, key: string, value: string): Promise<void> {
    const namespaced = buildTenantConfigKey(tenantId, key);

    // Guard: if cache grows beyond max entries, evict a small fraction of expired/old entries.
    if (this.store.size >= this.maxEntries) {
      this.evictSome();
    }

    const expiresAtMs = nowMs() + this.ttlSeconds * 1000;
    this.store.set(namespaced, { value, expiresAtMs });
  }

  /**
   * Flush all keys for a tenant namespace.
   */
  async flushTenant(tenantId: string): Promise<void> {
    const prefix = `tenant::${tenantId}::config::`;
    for (const k of Array.from(this.store.keys())) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  private evictSome() {
    // Remove expired entries first.
    const t = nowMs();
    let removed = 0;
    for (const [k, entry] of this.store.entries()) {
      if (entry.expiresAtMs <= t) {
        this.store.delete(k);
        removed++;
      }
      if (removed >= 200) break;
    }

    // If still too large, remove first N keys.
    if (this.store.size >= this.maxEntries) {
      const keys = Array.from(this.store.keys()).slice(0, 500);
      for (const k of keys) this.store.delete(k);
    }
  }
}

