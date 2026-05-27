import type { NextFunction, Request, Response } from 'express';
import { EnclaveLogShield } from '../services/security/EnclaveLogShield.js';
import { getConfidentialErrorPayload } from '../services/security/EnclaveErrors.js';

/**
 * Global Express error interceptor.
 *
 * - Prevents stack traces / dependency traces from reaching host logs or clients.
 * - Always responds with trackingId only.
 */
export function logShieldErrorInterceptor(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // If we already used ConfidentialBaseError, it has a stable trackingId.
  const confidentialPayload = getConfidentialErrorPayload(err);
  if (confidentialPayload) {
    // sanitize any accidentally-attached details before any internal logging happens.
    const safe = EnclaveLogShield.sanitizeAny((err as any)?.details ?? (err as any)?.payload ?? undefined);

    // Intentionally do NOT log cleartext to host console.
    void safe;

    res.status(confidentialPayload.statusCode).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      trackingId: confidentialPayload.trackingId
    });
    return;
  }

  const sanitized = EnclaveLogShield.sanitizeError(err);

  // Host console must not leak cleartext.
  // (In a real deployment, the host console output is untrusted.)
  res.status(500).json({
    status: 'FAILED',
    error: sanitized.message,
    trackingId: sanitized.trackingId
  });
}

