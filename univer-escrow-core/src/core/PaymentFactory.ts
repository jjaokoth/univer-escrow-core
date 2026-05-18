import type { IPaymentProvider } from './IPaymentProvider';
import { MpesaAdapter } from '../adapters/MpesaAdapter';

export class PaymentFactory {
  /**
   * Resolves explicit implementation instances bound to unified contract definitions
   */
  static getProvider(providerType: string): IPaymentProvider {
    const canonicalType = providerType.toUpperCase().trim();

    switch (canonicalType) {
      case 'MPESA':
        return new MpesaAdapter();
      default:
        throw new Error(
          `Execution Fault: Payment gateway provider [${providerType}] is unsupported or unauthorized.`,
        );
    }
  }
}

