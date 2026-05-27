import crypto from 'crypto';
import { EnclaveLogShield } from './EnclaveLogShield.js';

export type ConfidentialErrorPayload = {
  trackingId: string;
  safeMessage: string;
  statusCode: number;
};

export type RawPayload = {
  commitment?: string;
  transactionId?: string;
  signature?: string;
  [key: string]: unknown;
};

export class ConfidentialBaseError extends Error {
  public readonly trackingId: string;
  public readonly statusCode: number;

  // Safe-only message returned to callers.
  constructor(args: { statusCode: number; publicMessage: string; rawPayload?: unknown }) {
    const trackingId = crypto.randomUUID();
    super('INTERNAL_ERROR');

    this.name = 'ConfidentialBaseError';
    this.trackingId = trackingId;
    this.statusCode = args.statusCode;

    // If a developer passes raw payload, store cleartext only in enclave volatile buffer.
    if (args.rawPayload !== undefined) {
      EnclaveLogShield.putCleartext(trackingId, args.rawPayload);
    }

    // Expose only safe trackingId to public.
    // NOTE: message must be constant to avoid leaking.
    void args.publicMessage;
  }
}

export class ConfidentialLedgerError extends ConfidentialBaseError {
  constructor(args: { publicMessage: string; rawPayload?: RawPayload }) {
    super({ statusCode: 500, publicMessage: args.publicMessage, rawPayload: args.rawPayload });
    this.name = 'ConfidentialLedgerError';
  }
}

export class BftQuorumException extends ConfidentialBaseError {
  constructor(args: { publicMessage: string; rawPayload?: RawPayload }) {
    super({ statusCode: 409, publicMessage: args.publicMessage, rawPayload: args.rawPayload });
    this.name = 'BftQuorumException';
  }
}

export class DatabaseLockConflictError extends ConfidentialBaseError {
  constructor(args: { publicMessage: string; rawPayload?: RawPayload }) {
    super({ statusCode: 409, publicMessage: args.publicMessage, rawPayload: args.rawPayload });
    this.name = 'DatabaseLockConflictError';
  }
}

export function getConfidentialErrorPayload(err: unknown): ConfidentialErrorPayload | null {
  if (err instanceof ConfidentialBaseError) {
    return {
      trackingId: err.trackingId,
      safeMessage: 'INTERNAL_ERROR',
      statusCode: err.statusCode
    };
  }
  return null;
}

