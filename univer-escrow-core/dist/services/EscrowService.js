"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EscrowService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const EscrowState_1 = require("../core/EscrowState");
// Firestore Admin SDK is required for production. The scaffold keeps imports
// local-safe for compilation.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const admin = (() => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        // @ts-ignore
        return require('firebase-admin');
    }
    catch {
        return null;
    }
})();
function getMasterKey() {
    const k = process.env.ENV_MASTER_KEY ?? process.env.MASTER_INTEGRITY_KEY;
    if (!k)
        throw new Error('ENV_MASTER_KEY_MISSING');
    return k;
}
function computeMutationIntegrityHash(args) {
    const payload = `${args.escrowId}:${args.oldState}:${args.newState}:${args.timestamp}`;
    return crypto_1.default.createHmac('sha256', args.masterKey).update(payload).digest('hex');
}
function isTerminalStatus(status) {
    return status === EscrowState_1.EscrowStatus.RELEASED || status === EscrowState_1.EscrowStatus.REFUNDED;
}
function assertStateRules(args) {
    const { oldState, nextStatus } = args;
    // Terminal locking: no transitions out of terminal states.
    if (isTerminalStatus(oldState)) {
        throw new Error(`INVALID_STATE_TRANSITION_${oldState}_TO_${nextStatus}`);
    }
    // Enforce LOCKED rule: only allow transition to LOCKED if cryptographically verified.
    // (Verification is done in updateStatus by calling provider.verifyTransaction.)
    // Therefore, this assertion only checks that LOCKED isn't reached directly from an invalid old state.
    if (nextStatus === EscrowState_1.EscrowStatus.LOCKED) {
        if (oldState !== EscrowState_1.EscrowStatus.PENDING) {
            throw new Error(`INVALID_STATE_TRANSITION_${oldState}_TO_LOCKED`);
        }
    }
}
function initFirestore() {
    if (!admin) {
        throw new Error('FIREBASE_ADMIN_MISSING');
    }
    const appOptions = {};
    if (process.env.FIREBASE_PROJECT_ID) {
        appOptions.projectId = process.env.FIREBASE_PROJECT_ID;
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        appOptions.credential = admin.credential.applicationDefault();
    }
    if (!admin.apps.length) {
        admin.initializeApp(appOptions);
    }
    return admin.firestore();
}
class EscrowService {
    paymentProviderResolver;
    constructor(paymentProviderResolver) {
        this.paymentProviderResolver = paymentProviderResolver;
    }
    // Public API mandated by WebhookController
    async updateStatus(input) {
        // Strict state engine implementation
        return this.updateStatusAtomic(input);
    }
    // Minimal phase-1 orchestration stub kept for compatibility.
    async initiate(params) {
        const provider = this.paymentProviderResolver(params.providerType);
        const payment = await provider.initializePayment(params.amount, params.currency, params.metadata);
        const status = payment?.status === 'SUCCESS' ? EscrowState_1.EscrowStatus.RELEASED : EscrowState_1.EscrowStatus.LOCKED;
        return { status, payment };
    }
    /**
     * updateStatusAtomic - strict state engine with atomic Firestore transactions
     * and an immutable audit trail.
     */
    async updateStatusAtomic(input) {
        const firestore = initFirestore();
        const { escrowId, nextStatus, provider, mutationReason, transactionId } = input;
        const masterKey = getMasterKey();
        const escrowRef = firestore.collection('escrows').doc(escrowId);
        const auditRef = escrowRef.collection('audit_trail');
        await firestore.runTransaction(async (tx) => {
            const snap = await tx.get(escrowRef);
            if (!snap.exists) {
                throw new Error('ESCROW_NOT_FOUND');
            }
            const data = snap.data();
            const oldState = data.status;
            assertStateRules({ oldState, nextStatus });
            // LOCKED cryptographic verification rule.
            if (nextStatus === EscrowState_1.EscrowStatus.LOCKED) {
                const token = transactionId ?? data.transactionId;
                if (!token) {
                    throw new Error('NO_TRANSACTION_ID_FOR_LOCKED');
                }
                const verified = await provider.verifyTransaction(token);
                if (!verified) {
                    throw new Error('LOCKED_REQUIRES_VERIFIED_PAYMENT');
                }
            }
            // Terminal rule already enforced by assertStateRules.
            // Perform update.
            const now = new Date();
            const timestamp = now.toISOString();
            const integrityHash = computeMutationIntegrityHash({
                escrowId,
                oldState,
                newState: nextStatus,
                timestamp,
                masterKey,
            });
            // Update parent document.
            const updatePayload = {
                status: nextStatus,
                updatedAt: now,
                ...(nextStatus === EscrowState_1.EscrowStatus.LOCKED ? { lockedAt: now } : {}),
                ...(nextStatus === EscrowState_1.EscrowStatus.DISPUTED ? { disputeReason: mutationReason ?? 'DISPUTED' } : {}),
                ...(nextStatus === EscrowState_1.EscrowStatus.RELEASED ? { releasedAt: now } : {}),
                ...(nextStatus === EscrowState_1.EscrowStatus.REFUNDED ? { refundedAt: now } : {}),
                ...(transactionId ? { transactionId } : {}),
            };
            tx.update(escrowRef, updatePayload);
            const audit = {
                createdAt: now,
                oldState,
                newState: nextStatus,
                integrityHash,
                mutationReason,
            };
            // Immutable audit record.
            const auditDoc = auditRef.doc();
            tx.set(auditDoc, audit);
        });
    }
}
exports.EscrowService = EscrowService;
