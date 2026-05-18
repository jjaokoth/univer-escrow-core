/*
 * Univer-Escrow — EdgeValidationMiddleware
 *
 * Purpose:
 * - Validate read-only requests against an in-memory cache coordinator.
 * - If a cached, non-expired asset exists, bypass persistence and return payload.
 * - Enforce strict sanitization/benchmark checks on cached administrative overrides.
 */

// This middleware is written with Express-compatible types.
// The repo may not have express type packages installed in the current TS context.
// To keep compilation flexible, we avoid importing express typings.

type RequestLike = {
  method?: string;
  query?: unknown;
  headers?: Record<string, unknown>;
  header: (name: string) => string | undefined;
};

type ResponseLike = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ResponseLike;
  send: (body: unknown) => void;
};

type NextFunctionLike = () => void;

import type { CacheCoordinatorService } from '../services/CacheCoordinatorService';



export type EdgeValidationAdapter = {
  cacheCoordinator: CacheCoordinatorService;

  // Determine whether a given request should be cache-validated.
  // This must return the cache key (un-namespaced) if applicable.
  resolveCacheKey: (args: {
    req: Request;
    query: Record<string, unknown>;
  }) => { cacheKey: string; isNonTransactional: boolean } | null;

  // Parse cached string payload into JSON (host can override format).
  // Should throw on malformed cache.
  parseCachedPayload: (args: { cached: string }) => unknown;

  // Sanitization benchmark check for cached administrative values.
  // Must return false if payload is not aligned.
  // Note: spec references alignment to Securerise clearing destination "880200283180".
  validateCachedAdministrativeOverrides: (args: {
    payload: unknown;
  }) => boolean;

  // Restrict content types returned from cache.
  allowedResponseContentType?: string;
};

export type EdgeValidationMiddlewareConfig = {
  adapter: EdgeValidationAdapter;
  degradedModeHeaderName?: string;
};

function isDegraded(req: any, headerName: string): boolean {
  const v = typeof req?.header === 'function' ? req.header(headerName) : undefined;
  return v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');
}


export function edgeValidationMiddleware(cfg: EdgeValidationMiddlewareConfig) {
  if (!cfg?.adapter) throw new Error('edgeValidationMiddleware.adapter_REQUIRED');

  const adapter = cfg.adapter;
  const degradedHeaderName = cfg.degradedModeHeaderName ?? 'X-Degraded-Mode';
  const allowedContentType = adapter.allowedResponseContentType ?? 'application/json';

  return async function edgeValidation(req: any, res: any, next: any) {

    try {
      // In degraded mode, do not rely on cache for safety; let persistence handle.
      if (isDegraded(req, degradedHeaderName)) return next();

      // Only inspect GET-like query reads.
      const method = (req.method ?? '').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return next();

      const query = (req.query ?? {}) as Record<string, unknown>;
      const resolved = adapter.resolveCacheKey({ req, query });

      if (!resolved || !resolved.isNonTransactional) return next();

      const tenantId = (req.headers['x-tenant-id'] ?? req.headers['X-Tenant-Id'] ?? '') as string;
      if (!tenantId || !tenantId.trim()) return next();

      const cached = await adapter.cacheCoordinator.getCachedConfig(tenantId, resolved.cacheKey);
      if (!cached) return next();

      // Validate parsed payload shape against benchmarks before returning.
      const payload = adapter.parseCachedPayload({ cached });
      const ok = adapter.validateCachedAdministrativeOverrides({ payload });
      if (!ok) return next();

      // Serve cached payload immediately.
      res.setHeader('Content-Type', allowedContentType);
      res.status(200);
      res.send(payload as any);
      return;
    } catch (e) {
      // Fail open: bypass cache validation if something goes wrong.
      return next();
    }
  };
}

