import * as http from 'http';
import * as crypto from 'crypto';
import * as process from 'process';
import { URL } from 'url';
import { EscrowRouter } from './services/EscrowRouter';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;

interface JsonObject {
  [key: string]: JsonValue;
}

interface JsonArray extends Array<JsonValue> {}

function nowIso(): string {
  return new Date().toISOString();
}

function logStdout(event: string, level: 'INFO' | 'WARN' | 'ERROR', details: Record<string, JsonValue>): void {
  const payload: Record<string, JsonValue> = {
    ts: nowIso(),
    event: event as unknown as JsonValue,
    level: level as unknown as JsonValue,
    ...details,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const total = chunks.reduce((sum, b) => sum + b.length, 0);
      if (total > 1_000_000) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function jsonResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
  });
  res.end(payload);
}

function normalizeString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid or missing string field: ${fieldName}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid or missing string field: ${fieldName}`);
  }
  return trimmed;
}

function normalizeNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid number for ${fieldName}`);
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${fieldName}`);
    return parsed;
  }
  throw new Error(`Invalid or missing numeric field: ${fieldName}`);
}

function parseBasicApiRequestId(req: http.IncomingMessage): string {
  const header = req.headers['x-request-id'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  const seed = `${nowIso()}_${crypto.randomBytes(8).toString('hex')}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function verifyOutOfBandSignature(_tenantId: string, _payloadHash: string, signature: unknown): void {
  if (typeof signature !== 'string' || signature.trim().length === 0) {
    throw new Error('Missing out-of-band signature');
  }
}

async function handleLock(req: http.IncomingMessage, res: http.ServerResponse, router: EscrowRouter, requestId: string): Promise<void> {
  const bodyBuf = await readRequestBody(req);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf-8'));
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    jsonResponse(res, 400, { error: 'Invalid request payload' });
    return;
  }

  const obj = parsed as Record<string, unknown>;

  const tenantId = normalizeString(obj['tenantId'], 'tenantId');
  const amount = normalizeNumber(obj['amount'], 'amount');
  const signature = obj['signature'];

  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ tenantId, amount })).digest('hex');
  verifyOutOfBandSignature(tenantId, payloadHash, signature);

  logStdout('api_lock_request_received', 'INFO', { requestId, tenantId, amount });

  const lockResult = router.lockFunds(tenantId, amount);

  logStdout('api_lock_request_completed', 'INFO', {
    requestId,
    tenantId,
    transactionId: lockResult.transactionId,
    amount: lockResult.amount,
  });

  jsonResponse(res, 200, lockResult);
}

async function handleRelease(req: http.IncomingMessage, res: http.ServerResponse, router: EscrowRouter, requestId: string): Promise<void> {
  const bodyBuf = await readRequestBody(req);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf-8'));
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    jsonResponse(res, 400, { error: 'Invalid request payload' });
    return;
  }

  const obj = parsed as Record<string, unknown>;

  const transactionId = normalizeString(obj['transactionId'], 'transactionId');
  const signature = obj['signature'];

  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ transactionId })).digest('hex');
  verifyOutOfBandSignature('unknown', payloadHash, signature);

  const settlementAccountEnv = process.env.SETTLEMENT_ACCOUNT;

  logStdout('api_release_request_received', 'INFO', {
    requestId,
    transactionId,
    settlementAccountProfile: 'SETTLEMENT_ACCOUNT',
    hasSettlementAccountEnv: typeof settlementAccountEnv === 'string' && settlementAccountEnv.trim().length > 0,
  });

  const releaseResult = router.releaseToSettlement(transactionId);

  logStdout('api_release_request_completed', 'INFO', {
    requestId,
    transactionId,
    tenantId: releaseResult.tenantId,
    routedSettlementAccount: releaseResult.settlementAccount,
    amount: releaseResult.amount,
  });

  jsonResponse(res, 200, releaseResult);
}

function nativeErrorBoundary(res: http.ServerResponse, requestId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Unknown error';
  logStdout('request_error', 'ERROR', { requestId, message });
  jsonResponse(res, 500, { error: message });
}

const router = new EscrowRouter({ maxMilestones: 3 });

const server = http.createServer(async (req, res) => {
  const requestId = parseBasicApiRequestId(req);

  try {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);

    logStdout('request_started', 'INFO', {
      requestId,
      method: method as unknown as JsonValue,
      path: url.pathname as unknown as JsonValue,
    });

    if (method === 'POST' && url.pathname === '/api/escrow/lock') {
      await handleLock(req, res, router, requestId);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/escrow/release') {
      await handleRelease(req, res, router, requestId);
      return;
    }

    if (method === 'GET' && url.pathname === '/health') {
      logStdout('health_checked', 'INFO', { requestId });
      jsonResponse(res, 200, { ok: true, ts: nowIso() });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (err) {
    nativeErrorBoundary(res, requestId, err);
  }
});

const port = (() => {
  const p = process.env.PORT;
  if (typeof p !== 'string' || p.trim().length === 0) return 8080;
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return 8080;
  return Math.floor(n);
})();

server.listen(port, '0.0.0.0', () => {
  logStdout('server_started', 'INFO', { port, runtime: 'node-http-native' });
});

