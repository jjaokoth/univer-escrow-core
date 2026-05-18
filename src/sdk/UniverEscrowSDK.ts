/*
 * Univer‑Escrow Distribution Client SDK (NPM‑ready)
 *
 * Security boundary:
 * - This SDK ONLY handles public client orchestration inputs.
 * - It does NOT implement proprietary vault hashing algorithms.
 * - It does NOT embed routing topology or secret signing keys.
 *
 * It sends transaction intents to the public API gateway using
 * an application‑scoped Authorization bearer token.
 */

export type InitiateTransactionResult = {
  success: boolean;
  escrowId?: string;
  // Server may return rail-specific fields.
  [key: string]: unknown;
};

export type PollTransactionStatusResult = {
  escrowId: string;
  status: 'PENDING' | 'LOCKED' | 'DISPUTED' | 'RELEASED' | 'REFUNDED' | string;
  // Server may return additional fields.
  [key: string]: unknown;
};

export type SDKConfig = {
  /** Public API base URL, e.g. https://gateway.example.com */
  baseUrl: string;

  /** Tenant/client application identifier derived by the platform (NOT secret). */
  clientId: string;

  /** Secret key provisioned out-of-band. Must be provided by the integrator exactly once. */
  secretKey: string;

  /** Optional integrity signature header value if your gateway requires it. */
  integrityHeaderValue?: string;

  /** Optional default fetch options. */
  fetchOptions?: RequestInit;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function toJsonBody(payload: unknown): string {
  return JSON.stringify(payload);
}

async function fetchJson<T>(args: {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: unknown;
  fetchOptions?: RequestInit;
}): Promise<T> {
  const { url, method, headers, body, fetchOptions } = args;

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : toJsonBody(body),
    ...fetchOptions,
  });

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!res.ok) {
    const err = new Error('Univer-Escrow API request failed');
    (err as any).status = res.status;
    (err as any).payload = parsed;
    throw err;
  }

  return parsed as T;
}

/**
 * UniverEscrowSDK
 *
 * Lightweight promise-based interface for integrators.
 */
export class UniverEscrowSDK {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly secretKey: string;
  private readonly integrityHeaderValue?: string;
  private readonly fetchOptions?: RequestInit;

  constructor(config: SDKConfig) {
    if (!config.baseUrl) throw new Error('SDKConfig.baseUrl_REQUIRED');
    if (!config.clientId) throw new Error('SDKConfig.clientId_REQUIRED');
    if (!config.secretKey) throw new Error('SDKConfig.secretKey_REQUIRED');

    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.clientId = config.clientId;
    this.secretKey = config.secretKey;
    this.integrityHeaderValue = config.integrityHeaderValue;
    this.fetchOptions = config.fetchOptions;
  }

  /**
   * initiateTransaction
   * Sends a transaction intent to the gateway.
   */
  async initiateTransaction(
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
  ): Promise<InitiateTransactionResult> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('amount_INVALID');
    }
    if (!currency) throw new Error('currency_REQUIRED');

    // Authorization: Bearer <secretKey>
    // The server must use tenant scoping and secret-key hashing internally.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };

    // Optional integrity header for gateways that enforce it.
    if (this.integrityHeaderValue) {
      headers['x-securerise-integrity'] = this.integrityHeaderValue;
    }

    const payload = {
      clientId: this.clientId,
      amount,
      currency,
      metadata,
    };

    return fetchJson<InitiateTransactionResult>({
      url: `${this.baseUrl}/api/v1/payments/initiate`,
      method: 'POST',
      headers,
      body: payload,
      fetchOptions: this.fetchOptions,
    });
  }

  /**
   * pollTransactionStatus
   */
  async pollTransactionStatus(escrowId: string): Promise<PollTransactionStatusResult> {
    if (!escrowId) throw new Error('escrowId_REQUIRED');

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
    };

    if (this.integrityHeaderValue) {
      headers['x-securerise-integrity'] = this.integrityHeaderValue;
    }

    return fetchJson<PollTransactionStatusResult>({
      url: `${this.baseUrl}/api/v1/escrows/${encodeURIComponent(escrowId)}`,
      method: 'GET',
      headers,
      fetchOptions: this.fetchOptions,
    });
  }
}

