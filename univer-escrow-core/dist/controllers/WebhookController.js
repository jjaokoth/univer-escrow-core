"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookController = void 0;
const PaymentFactory_1 = require("../core/PaymentFactory");
const EscrowService_1 = require("../services/EscrowService");
const EscrowState_1 = require("../core/EscrowState");
/**
 * Universal Webhook Aggregator
 * POST /api/v1/gateways/callbacks/:provider
 *
 * Decoupling Protocol:
 * - Parse provider path param
 * - Delegate provider verification using PaymentFactory
 * - Cross-reference with the integrity payload forwarded by IntegrityMiddleware
 * - Update escrow status via EscrowService with strict state rules
 */
class WebhookController {
    escrowService;
    constructor(escrowService = new EscrowService_1.EscrowService(PaymentFactory_1.PaymentFactory.getProvider)) {
        this.escrowService = escrowService;
    }
    async handleCallback(req, res, next) {
        try {
            const providerType = (req.params.provider ?? '').toUpperCase().trim();
            if (!providerType) {
                return res.status(400).json({ error: 'PROVIDER_REQUIRED' });
            }
            // Integrity cross-reference. IntegrityMiddleware is expected to have
            // verified signature and set __integrity_verified.
            const integrityVerified = Boolean(req.__integrity_verified);
            if (!integrityVerified) {
                return res.status(403).json({ error: 'INTEGRITY_NOT_VERIFIED' });
            }
            // Parse provider payload in a provider-agnostic way.
            const body = req.body;
            const metadata = {
                // M-Pesa often includes: ResultCode, CheckoutRequestID, MerchantRequestID, CallbackMetadata, etc.
                resultCode: body?.ResultCode ?? body?.resultCode ?? body?.Body?.stkCallback?.ResultCode,
                checkoutRequestId: body?.CheckoutRequestID ?? body?.checkoutRequestId ?? body?.Body?.stkCallback?.CheckoutRequestID,
                merchantRequestId: body?.MerchantRequestID ?? body?.merchantRequestId ?? body?.Body?.stkCallback?.MerchantRequestID,
                callbackMetadata: body?.CallbackMetadata ?? body?.callbackMetadata ?? body?.Body?.stkCallback?.CallbackMetadata,
                // fallback token for verification
                transactionId: body?.transactionId ?? body?.TransactionID ?? body?.CheckoutRequestID ?? body?.checkoutRequestId,
            };
            const escrowId = metadata.callbackMetadata?.escrowId ??
                body?.escrowId ??
                body?.AccountReference ??
                body?.accountReference;
            const transactionId = metadata.transactionId ?? metadata.checkoutRequestId ?? metadata.merchantRequestId;
            if (!transactionId) {
                return res.status(400).json({ error: 'TRANSACTION_ID_REQUIRED' });
            }
            const provider = PaymentFactory_1.PaymentFactory.getProvider(providerType);
            const verified = await provider.verifyTransaction(transactionId);
            const resultCodeOk = String(metadata.resultCode ?? '').trim() === '0';
            if (!verified || !resultCodeOk) {
                // Failed capture: mark as DISPUTED to avoid release.
                // (In a later phase, a CANCEL/REFUND terminal may be added.)
                const targetEscrowId = escrowId;
                if (!targetEscrowId) {
                    return res.status(200).json({
                        success: true,
                        ignored: true,
                        reason: 'ESCROW_ID_MISSING_ON_FAILURE',
                        transactionId,
                    });
                }
                await this.escrowService.updateStatus({
                    escrowId: targetEscrowId,
                    nextStatus: EscrowState_1.EscrowStatus.DISPUTED,
                    mutationReason: 'PAYMENT_FAILED',
                    provider,
                });
                return res.status(200).json({ success: true, escrowId: targetEscrowId, status: EscrowState_1.EscrowStatus.DISPUTED });
            }
            if (!escrowId) {
                return res.status(404).json({ error: 'ESCROW_ID_NOT_FOUND' });
            }
            await this.escrowService.updateStatus({
                escrowId,
                nextStatus: EscrowState_1.EscrowStatus.LOCKED,
                mutationReason: 'PAYMENT_VERIFIED',
                provider,
                transactionId,
            });
            return res.status(200).json({
                success: true,
                escrowId,
                status: EscrowState_1.EscrowStatus.LOCKED,
                transactionId,
            });
        }
        catch (err) {
            if (next)
                return next(err);
            return res.status(500).json({ error: 'WEBHOOK_CALLBACK_FAILED', detail: String(err?.message ?? err) });
        }
    }
}
exports.WebhookController = WebhookController;
