/**
 * © 2026 Securerise Solutions Limited
 * ThrottlingMiddleware — tenant-scoped sliding-window rate-limit enforcement.
 *
 * Expected request context:
 * - tenantId from request header: x-tenant-id (or X-Tenant-Id)
 * - clientKey from request header: x-api-key
 *
 * Behavior:
 * - If exceeded, respond 429 with Retry-After header.
 * - If allowed, set X-RateLimit-* headers and call next().
 */

type NextFunction = (err?: any) => void;

type Request = {
  header: (name: string) => string | undefined;
};

type Response = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => Response;
  json: (body: unknown) => void;
};


import { RateLimitingService } from '../services/RateLimitingService';

export type ThrottlingMiddlewareConfig = {
  rateLimiter: RateLimitingService;
  maxRequests: number;
  /** Retry interval multiplier used when computing Retry-After. Default: 1. */
  retryAfterMultiplier?: number;
  /** Tenant header name. Default: x-tenant-id */
  tenantHeaderName?: string;
  /** Client key header name. Default: x-api-key */
  clientKeyHeaderName?: string;
};

function getHeader(req: Request, name: string): string {
  const v = req.header(name);
  return typeof v === 'string' ? v : '';
}

function computeRetryAfterSeconds(args: { windowMs: number; retryAfterMultiplier: number }): number {
  // With sliding windows we cannot know the exact next slot; return a deterministic
  // lower bound that will clear the window.
  const baseMs = args.windowMs;
  const ms = Math.max(0, Math.floor(baseMs * args.retryAfterMultiplier));
  const sec = Math.ceil(ms / 1000);
  return sec > 0 ? sec : 1;
}

export function throttlingMiddleware(cfg: ThrottlingMiddlewareConfig) {
  if (!cfg?.rateLimiter) throw new Error('throttlingMiddleware.rateLimiter_REQUIRED');
  if (!Number.isFinite(cfg.maxRequests) || (cfg.maxRequests as number) <= 0) {
    throw new Error('throttlingMiddleware.maxRequests_REQUIRED');
  }

  const rateLimiter = cfg.rateLimiter;
  const maxRequests = cfg.maxRequests;
  const retryAfterMultiplier = cfg.retryAfterMultiplier ?? 1;
  const tenantHeaderName = cfg.tenantHeaderName ?? 'x-tenant-id';
  const clientKeyHeaderName = cfg.clientKeyHeaderName ?? 'x-api-key';

  // RateLimitingService exposes windowMs internally; keep retry-after deterministic
  // by using a default of 60s when not available.
  const windowMsGuess = 60_000;

  return function throttling(req: Request, res: Response, next: NextFunction) {
    const tenantId = getHeader(req, tenantHeaderName);
    const clientKey = getHeader(req, clientKeyHeaderName);

    // If tenant/client key are missing, treat as exceeded (secure default).
    const exceeded =
      !tenantId.trim() || !clientKey.trim()
        ? true
        : rateLimiter.isRateLimitExceeded(tenantId, clientKey, maxRequests);

    if (!exceeded) {
      const remaining = rateLimiter.getRemaining(tenantId, clientKey, maxRequests);
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      return next();
    }

    const retryAfterSeconds = computeRetryAfterSeconds({ windowMs: windowMsGuess, retryAfterMultiplier });
    res.setHeader('Retry-After', String(retryAfterSeconds));

    // Minimal, clean payload.
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Request throttled',
      retryAfterSeconds,
      trace: {
        tenantId: tenantId || undefined,
        clientKeyPresent: !!clientKey.trim(),
      },
    });
  };
}

