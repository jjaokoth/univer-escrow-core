import type { PaymentResult } from './EscrowState';

export interface IPaymentProvider {
  /**
   * Dispatches outbound request to initiate target client collection sequence
   */
  initializePayment(amount: number, currency: string, metadata: any): Promise<PaymentResult>;

  /**
   * Queries downstream gateway records to verify absolute transaction status
   */
  verifyTransaction(transactionId: string): Promise<boolean>;

  /**
   * Executes reverse-settlement protocol returning money to source entity
   */
  initiateRefund(transactionId: string, amount?: number): Promise<boolean>;
}

