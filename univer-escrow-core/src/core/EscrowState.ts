export enum EscrowStatus {
  PENDING = 'PENDING', // Intent initialized, awaiting customer deposit confirmation
  LOCKED = 'LOCKED', // Funds verified inside escrow account, milestone tracking active
  DISPUTED = 'DISPUTED', // Arbitrated state, funds held until mediation confirms settlement
  RELEASED = 'RELEASED', // Funds successfully routed to destination vendor account
  REFUNDED = 'REFUNDED', // Funds returned back to source client address
}

export interface PaymentResult {
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  transactionId?: string;
  rawResponse?: any;
  errorMessage?: string;
}

