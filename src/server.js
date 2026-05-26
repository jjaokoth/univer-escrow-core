"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const http = __importStar(require("http"));
const crypto = __importStar(require("crypto"));
const process = __importStar(require("process"));
const url_1 = require("url");
const EscrowRouter_1 = require("./services/EscrowRouter");
function nowIso() {
    return new Date().toISOString();
}
function logStdout(event, level, details) {
    const payload = {
        ts: nowIso(),
        event: event,
        level: level,
        ...details,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
}
function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => {
            chunks.push(chunk);
            const total = chunks.reduce((sum, b) => sum + b.length, 0);
            if (total > 1000000) {
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', (err) => reject(err));
    });
}
function jsonResponse(res, statusCode, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(payload.length),
    });
    res.end(payload);
}
function normalizeString(value, fieldName) {
    if (typeof value !== 'string') {
        throw new Error(`Invalid or missing string field: ${fieldName}`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`Invalid or missing string field: ${fieldName}`);
    }
    return trimmed;
}
function normalizeNumber(value, fieldName) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error(`Invalid number for ${fieldName}`);
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed))
            throw new Error(`Invalid number for ${fieldName}`);
        return parsed;
    }
    throw new Error(`Invalid or missing numeric field: ${fieldName}`);
}
function parseBasicApiRequestId(req) {
    const header = req.headers['x-request-id'];
    if (typeof header === 'string' && header.trim().length > 0)
        return header.trim();
    const seed = `${nowIso()}_${crypto.randomBytes(8).toString('hex')}`;
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}
function verifyOutOfBandSignature(_tenantId, _payloadHash, signature) {
    if (typeof signature !== 'string' || signature.trim().length === 0) {
        throw new Error('Missing out-of-band signature');
    }
}
async function handleLock(req, res, router, requestId) {
    const bodyBuf = await readRequestBody(req);
    let parsed;
    try {
        parsed = JSON.parse(bodyBuf.toString('utf-8'));
    }
    catch {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        jsonResponse(res, 400, { error: 'Invalid request payload' });
        return;
    }
    const obj = parsed;
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
async function handleRelease(req, res, router, requestId) {
    const bodyBuf = await readRequestBody(req);
    let parsed;
    try {
        parsed = JSON.parse(bodyBuf.toString('utf-8'));
    }
    catch {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        jsonResponse(res, 400, { error: 'Invalid request payload' });
        return;
    }
    const obj = parsed;
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
function nativeErrorBoundary(res, requestId, err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logStdout('request_error', 'ERROR', { requestId, message });
    jsonResponse(res, 500, { error: message });
}
const router = new EscrowRouter_1.EscrowRouter({ maxMilestones: 3 });
const server = http.createServer(async (req, res) => {
    const requestId = parseBasicApiRequestId(req);
    try {
        const method = (req.method ?? 'GET').toUpperCase();
        const rawUrl = req.url ?? '/';
        const url = new url_1.URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
        logStdout('request_started', 'INFO', {
            requestId,
            method: method,
            path: url.pathname,
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
    }
    catch (err) {
        nativeErrorBoundary(res, requestId, err);
    }
});
const port = (() => {
    const p = process.env.PORT;
    if (typeof p !== 'string' || p.trim().length === 0)
        return 8080;
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0)
        return 8080;
    return Math.floor(n);
})();
server.listen(port, '0.0.0.0', () => {
    logStdout('server_started', 'INFO', { port, runtime: 'node-http-native' });
});
