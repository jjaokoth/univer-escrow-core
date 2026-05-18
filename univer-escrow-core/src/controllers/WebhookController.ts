import type { NextFunction, Request, Response } from 'express';
import { PaymentFactory } from '../core/PaymentFactory';
import { EscrowService } from '../services/EscrowService';
import { EscrowStatus } from '../core/EscrowState';

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
export class WebhookController {
  constructor(
    private escrowService: EscrowService = new EscrowService(PaymentFactory.getProvider as any),
  ) {}

  async handleCallback(req: Request, res: Response, next?: NextFunction) {
    try {
      const providerType = (req.params.provider ?? '').toUpperCase().trim();

      if (!providerType) {
        return res.status(400).json({ error: 'PROVIDER_REQUIRED' });
      }

      // Integrity cross-reference. IntegrityMiddleware is expected to have
      // verified signature and set __integrity_verified.
      const integrityVerified = Boolean((req as any).__integrity_verified);
      if (!integrityVerified) {
        return res.status(403).json({ error: 'INTEGRITY_NOT_VERIFIED' });
      }

      // Parse provider payload in a provider-agnostic way.
      const body = req.body as any;
      const metadata = {
        // M-Pesa often includes: ResultCode, CheckoutRequestID, MerchantRequestID, CallbackMetadata, etc.
        resultCode: body?.ResultCode ?? body?.resultCode ?? body?.Body?.stkCallback?.ResultCode,
        checkoutRequestId:
          body?.CheckoutRequestID ?? body?.checkoutRequestId ?? body?.Body?.stkCallback?.CheckoutRequestID,
        merchantRequestId:
          body?.MerchantRequestID ?? body?.merchantRequestId ?? body?.Body?.stkCallback?.MerchantRequestID,
        callbackMetadata: body?.CallbackMetadata ?? body?.callbackMetadata ?? body?.Body?.stkCallback?.CallbackMetadata,
        // fallback token for verification
        transactionId:
          body?.transactionId ?? body?.TransactionID ?? body?.CheckoutRequestID ?? body?.checkoutRequestId,
      };

      const escrowId: string | undefined =
        metadata.callbackMetadata?.escrowId ??
        body?.escrowId ??
        body?.AccountReference ??
        body?.accountReference;

      const transactionId: string | undefined =
        metadata.transactionId ?? metadata.checkoutRequestId ?? metadata.merchantRequestId;

      if (!transactionId) {
        return res.status(400).json({ error: 'TRANSACTION_ID_REQUIRED' });
      }

      const provider = PaymentFactory.getProvider(providerType);

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
          nextStatus: EscrowStatus.DISPUTED,
          mutationReason: 'PAYMENT_FAILED',
          provider,
        });

        return res.status(200).json({ success: true, escrowId: targetEscrowId, status: EscrowStatus.DISPUTED });
      }

      if (!escrowId) {
        return res.status(404).json({ error: 'ESCROW_ID_NOT_FOUND' });
      }

      await this.escrowService.updateStatus({
        escrowId,
        nextStatus: EscrowStatus.LOCKED,
        mutationReason: 'PAYMENT_VERIFIED',
        provider,
        transactionId,
      });

      return res.status(200).json({
        success: true,
        escrowId,
        status: EscrowStatus.LOCKED,
        transactionId,
      });
    } catch (err: any) {
      if (next) return next(err);
      return res.status(500).json({ error: 'WEBHOOK_CALLBACK_FAILED', detail: String(err?.message ?? err) });
    }
  }
}

