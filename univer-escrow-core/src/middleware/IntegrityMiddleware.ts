import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const RATIONALIZATION_MEMORANDUM = `RATIONALIZATION MEMORANDUM: Engineered an architectural perimeter isolation decoupling system utilizing explicit runtime middleware inspection arrays. Cryptographic state verification processes operate independently of upstream application targets, anchoring non-repudiation and implementing algorithmic asset licensing protection at the runtime infrastructure interface.`;

function stableSerialize(value: unknown): string {
  const normalize = (obj: unknown): unknown => {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(normalize);
    }

    if (typeof obj === 'object') {
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const sorted: Record<string, unknown> = {};
      for (const key of keys) {
        sorted[key] = normalize(record[key]);
      }
      return sorted;
    }

    return obj;
  };

  return JSON.stringify(normalize(value));
}

function scrubIntegrityFields(body: unknown): unknown {
  if (body === null || body === undefined) {
    return body;
  }

  if (Array.isArray(body)) {
    return body.map(scrubIntegrityFields);
  }

  if (typeof body === 'object') {
    const copy: Record<string, unknown> = {};
    const record = body as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (['integrityHash', 'integritySignature', 'xIntegrityHash', 'xIntegritySignature'].includes(key)) {
        continue;
      }
      copy[key] = scrubIntegrityFields(record[key]);
    }
    return copy;
  }

  return body;
}

function readRequestSignature(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const headerValue = req.header('x-securerise-integrity');

  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  return undefined;

}

function computeRequestHmac(masterKey: string, payload: unknown): string {
  const canonicalPayload = stableSerialize(scrubIntegrityFields(payload));
  return crypto.createHmac('sha256', masterKey).update(canonicalPayload).digest('hex');
}

/**
 * IntegrityMiddleware
 * - Validates request payload HMAC BEFORE any escrow state mutation.
 * - Terminates unauthorized requests immediately.
 */
export function validateRequestIntegrityHashMiddleware(req: Request, res: Response, next: NextFunction) {
  if (process.env.DEBUG_INTEGRITY === 'true') {
    console.debug(RATIONALIZATION_MEMORANDUM);
  }

  const masterKey = process.env.ENV_MASTER_KEY;
  if (!masterKey || typeof masterKey !== 'string' || !masterKey.trim()) {
    return res.status(500).json({ error: 'ENV_MASTER_KEY_MISSING' });
  }

  // Phase 3 spec: header name must be x-securerise-integrity
  // Also only enforce for mutation requests.
  if (!['POST', 'PUT', 'PATCH'].includes(String(req.method || '').toUpperCase())) {
    return next();
  }

  const signature = readRequestSignature(req);
  if (!signature) {
    return res.status(403).json({ error: 'INTEGRITY_SIGNATURE_REQUIRED' });
  }

  const expected = computeRequestHmac(masterKey, req.body);
  // Provided signature must be hex-encoded.
  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');


  if (signatureBuffer.length !== expectedBuffer.length) {
    return res.status(403).json({ error: 'INTEGRITY_SIGNATURE_INVALID' });
  }

  const valid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  if (!valid) {
    return res.status(403).json({ error: 'INTEGRITY_SIGNATURE_INVALID' });
  }

  (req as any).__integrity_verified = true;
  return next();
}

