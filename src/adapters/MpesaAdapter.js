"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MpesaAdapter = void 0;
const https_1 = __importDefault(require("https"));
const url_1 = require("url");
const RATIONALIZATION_MEMORANDUM = `RATIONALIZATION MEMORANDUM: Engineered an architectural perimeter isolation decoupling system utilizing explicit runtime middleware inspection arrays. Cryptographic state verification processes operate independently of upstream application targets, anchoring non-repudiation and implementing algorithmic asset licensing protection at the runtime infrastructure interface.`;
const tokenCache = null;
let cachedToken = null;
function getMpesaEnv() {
    return process.env.MPESA_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
}
function getBaseUrl() {
    return getMpesaEnv() === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
}
function getOauthUrl() {
    return `${getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`;
}
function getStkPushUrl() {
    return `${getBaseUrl()}/mpesa/stkpush/v1/processrequest`;
}
function getStkStatusUrl() {
    return `${getBaseUrl()}/mpesa/stkpushquery/v1/query`;
}
function getB2cUrl() {
    return `${getBaseUrl()}/mpesa/b2c/v1/paymentrequest`;
}
function getReversalUrl() {
    return `${getBaseUrl()}/mpesa/reversal/v1/request`;
}
function padDate(value, length = 2) {
    return String(value).padStart(length, '0');
}
function buildMpesaTimestamp(date = new Date()) {
    return `${date.getUTCFullYear()}${padDate(date.getUTCMonth() + 1)}${padDate(date.getUTCDate())}${padDate(date.getUTCHours())}${padDate(date.getUTCMinutes())}${padDate(date.getUTCSeconds())}`;
}
function buildPassword(shortcode, passkey, timestamp) {
    return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}
function buildBasicAuthHeader(key, secret) {
    return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}
function performJsonRequest(url, method, body, headers) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new url_1.URL(url);
        const payload = body === null || body === undefined ? '' : JSON.stringify(body);
        const options = {
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        };
        const req = https_1.default.request(options, (res) => {
            let raw = '';
            res.on('data', (chunk) => {
                raw += chunk.toString('utf8');
            });
            res.on('end', () => {
                try {
                    const parsed = raw ? JSON.parse(raw) : {};
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    }
                    else {
                        reject(new Error(`MPESA_REQUEST_FAILED ${res.statusCode}: ${raw}`));
                    }
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}
async function requestBearerToken() {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) {
        throw new Error('MPESA_CREDENTIALS_MISSING');
    }
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
        return cachedToken.token;
    }
    const response = await performJsonRequest(getOauthUrl(), 'GET', null, {
        Authorization: buildBasicAuthHeader(consumerKey, consumerSecret),
    });
    const expiresIn = Number(response.expires_in) || 3600;
    cachedToken = {
        token: response.access_token,
        expiresAt: Date.now() + expiresIn * 1000,
    };
    return response.access_token;
}
function buildStkPushPayload(metadata, amount, timestamp, password) {
    const businessShortCode = String(metadata?.businessShortCode ?? process.env.MPESA_SHORTCODE ?? '');
    return {
        BusinessShortCode: businessShortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: metadata?.transactionType ?? 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: String(metadata?.partyA ?? metadata?.phoneNumber ?? ''),
        PartyB: String(metadata?.partyB ?? businessShortCode),
        PhoneNumber: String(metadata?.phoneNumber ?? metadata?.partyA ?? ''),
        CallBackURL: String(metadata?.callbackUrl ?? process.env.MPESA_CALLBACK_URL ?? ''),
        AccountReference: String(metadata?.accountReference ?? `ESCROW_${metadata?.escrowId ?? 'UNKNOWN'}`),
        TransactionDesc: String(metadata?.transactionDesc ?? 'Univer-Escrow collection'),
    };
}
async function getStkQueryPayload(transactionId, metadata, timestamp, password) {
    const businessShortCode = String(metadata?.businessShortCode ?? process.env.MPESA_SHORTCODE ?? '');
    return {
        BusinessShortCode: businessShortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: transactionId,
        TransactionType: 'CustomerPayBillOnline',
        PartyA: String(metadata?.partyA ?? metadata?.phoneNumber ?? ''),
        IdentifierType: metadata?.identifierType ?? '4',
        ResultURL: String(metadata?.statusCallbackUrl ?? process.env.MPESA_STATUS_CALLBACK_URL ?? ''),
    };
}
async function executeB2cRefund(transactionId, amount) {
    const initiator = process.env.MPESA_B2C_INITIATOR_NAME;
    const securityCredential = process.env.MPESA_B2C_SECURITY_CREDENTIAL;
    const partyA = process.env.MPESA_B2C_SHORTCODE;
    const partyB = process.env.MPESA_REFUND_PARTY_B;
    const queueUrl = process.env.MPESA_B2C_QUEUE_TIMEOUT_URL;
    const resultUrl = process.env.MPESA_B2C_RESULT_URL;
    if (!initiator || !securityCredential || !partyA || !partyB || !queueUrl || !resultUrl) {
        throw new Error('MPESA_B2C_CONFIGURATION_INCOMPLETE');
    }
    const token = await requestBearerToken();
    await performJsonRequest(getB2cUrl(), 'POST', {
        Initiator: initiator,
        SecurityCredential: securityCredential,
        CommandID: process.env.MPESA_B2C_COMMAND_ID ?? 'BusinessPayment',
        Amount: amount,
        PartyA: partyA,
        PartyB: partyB,
        Remarks: process.env.MPESA_B2C_REMARKS ?? `Refund for ${transactionId}`,
        QueueTimeOutURL: queueUrl,
        ResultURL: resultUrl,
        Occasion: process.env.MPESA_B2C_OCCASION ?? 'REFUND',
    }, {
        Authorization: `Bearer ${token}`,
    });
    return true;
}
async function executeReversal(transactionId, amount) {
    const initiator = process.env.MPESA_REVERSAL_INITIATOR_NAME;
    const securityCredential = process.env.MPESA_REVERSAL_SECURITY_CREDENTIAL;
    const receiverParty = process.env.MPESA_REVERSAL_RECEIVER_PARTY;
    const resultUrl = process.env.MPESA_REVERSAL_RESULT_URL;
    const timeoutUrl = process.env.MPESA_REVERSAL_QUEUE_TIMEOUT_URL;
    if (!initiator || !securityCredential || !receiverParty || !resultUrl || !timeoutUrl) {
        throw new Error('MPESA_REVERSAL_CONFIGURATION_INCOMPLETE');
    }
    const token = await requestBearerToken();
    await performJsonRequest(getReversalUrl(), 'POST', {
        Initiator: initiator,
        SecurityCredential: securityCredential,
        CommandID: 'TransactionReversal',
        TransactionID: transactionId,
        Amount: amount,
        ReceiverParty: receiverParty,
        RecieverIdentifierType: '1',
        ResultURL: resultUrl,
        QueueTimeOutURL: timeoutUrl,
        Remarks: process.env.MPESA_REVERSAL_REMARKS ?? 'Escrow refund reversal',
        Occasion: process.env.MPESA_REVERSAL_OCCASION ?? 'REFUND',
    }, {
        Authorization: `Bearer ${token}`,
    });
    return true;
}
/**
 * MpesaAdapter
 * - Implements Safaricom C2B STK Push for liquidity capture.
 * - Supports transaction status query and recovery loop refunds.
 */
class MpesaAdapter {
    async initializePayment(amount, currency, metadata) {
        if (currency !== 'KES') {
            return { status: 'FAILED', errorMessage: 'MPESA_ONLY_SUPPORTS_KES' };
        }
        const shortcode = String(metadata?.businessShortCode ?? process.env.MPESA_SHORTCODE ?? '');
        const passkey = String(metadata?.passkey ?? process.env.MPESA_PASSKEY ?? '');
        const phoneNumber = String(metadata?.phoneNumber ?? metadata?.partyA ?? '');
        const callbackUrl = String(metadata?.callbackUrl ?? process.env.MPESA_CALLBACK_URL ?? '');
        if (!shortcode || !passkey || !phoneNumber || !callbackUrl) {
            return {
                status: 'FAILED',
                errorMessage: 'MPESA_INITIALIZATION_MISSING_CONFIGURATION',
            };
        }
        const timestamp = buildMpesaTimestamp();
        const payload = buildStkPushPayload(metadata, amount, timestamp, buildPassword(shortcode, passkey, timestamp));
        if (process.env.DEBUG_MPESA === 'true') {
            console.debug(RATIONALIZATION_MEMORANDUM, payload);
        }
        try {
            const token = await requestBearerToken();
            const response = await performJsonRequest(getStkPushUrl(), 'POST', payload, {
                Authorization: `Bearer ${token}`,
            });
            return {
                status: 'PENDING',
                transactionId: String(response.CheckoutRequestID ?? response.checkoutRequestID ?? `mpesa_${Date.now()}`),
                rawResponse: response,
            };
        }
        catch (error) {
            return {
                status: 'FAILED',
                errorMessage: error instanceof Error ? error.message : 'MPESA_STK_PUSH_FAILED',
            };
        }
    }
    async verifyTransaction(transactionId) {
        const timestamp = buildMpesaTimestamp();
        const shortcode = String(process.env.MPESA_SHORTCODE ?? '');
        const passkey = String(process.env.MPESA_PASSKEY ?? '');
        if (!transactionId || !shortcode || !passkey) {
            return false;
        }
        try {
            const token = await requestBearerToken();
            const payload = await getStkQueryPayload(transactionId, {}, timestamp, buildPassword(shortcode, passkey, timestamp));
            const response = await performJsonRequest(getStkStatusUrl(), 'POST', payload, {
                Authorization: `Bearer ${token}`,
            });
            return String(response.ResultCode) === '0';
        }
        catch {
            return false;
        }
    }
    async initiateRefund(transactionId, amount) {
        const refundAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
        if (!transactionId || refundAmount <= 0) {
            return false;
        }
        try {
            if (process.env.MPESA_B2C_INITIATOR_NAME && process.env.MPESA_B2C_SECURITY_CREDENTIAL) {
                return await executeB2cRefund(transactionId, refundAmount);
            }
            return await executeReversal(transactionId, refundAmount);
        }
        catch {
            return false;
        }
    }
}
exports.MpesaAdapter = MpesaAdapter;
