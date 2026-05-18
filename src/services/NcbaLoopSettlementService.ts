/******************************************************
 * NcbaLoopSettlementService.ts
 * ----------------------------------------------------
 * Tenant-scoped NCBA Loop settlement bridge.
 * This module performs lightweight validation and
 * constructs an atomic confirmation payload.
 *
 * External banking transmission is delegated to an
 * injected sender so this file remains testable and
 * does not perform blocking IO by default.
 ******************************************************/

import { createHash } from 'crypto';

export const NCBA_LOOP_CLEARING_ACCOUNT = '880200283180';

export type DestinationRoutingParameters = Record<string, unknown>;

export type NcbaBankConfirmationToken = {
  confirmationId: string;
  tenantId: string;
  transactionId: string;
  amount: number;
  clearingAccount: string;
  routedTo: DestinationRoutingParameters;
};

export interface NcbaBankSender {
  /**
   * Send settlement request to banking cluster.
   * Must be non-blocking at the call site (async).
   */
  sendSettlement(params: {
    tenantId: string;
    transactionAmount: number;
    clearingAccount: string;
    destinationRoutingParameters: DestinationRoutingParameters;
    // Host may include computed splits/fees.
    splits: { feeTotal: number; netTotal: number };
  }): Promise<{ ok: true; bankReference: string }>;
}

function stableHashHex(input: unknown): string {
  const canonical = JSON.stringify(input);
  return createHash('sha256').update(canonical).digest('hex');
}

export class NcbaLoopSettlementService {
  constructor(private readonly sender: NcbaBankSender) {}

  /**
   * Execute NCBA settlement clearance with strict clearing-account routing.
   */
  public async executeNcbaSettlementClearance(params: {
    tenantId: string;
    transactionAmount: number;
    destinationRoutingParameters: DestinationRoutingParameters;
  }): Promise<NcbaBankConfirmationToken> {
    const { tenantId, transactionAmount, destinationRoutingParameters } = params;

    if (!tenantId) throw new Error('tenantId is required');
    if (!Number.isFinite(transactionAmount) || transactionAmount <= 0) {
      throw new Error('transactionAmount must be a positive number');
    }

    // Fee/split computation is intentionally lightweight and deterministic.
    // Host can replace this logic with the repo's actual fee model.
    const feeTotal = Math.round(transactionAmount * 0.01 * 100) / 100; // 1% fee
    const netTotal = Math.round((transactionAmount - feeTotal) * 100) / 100;

    // Strict alignment: route all splits into the canonical clearing pool.
    const clearingAccount = NCBA_LOOP_CLEARING_ACCOUNT;

    const txId = stableHashHex({
      tenantId,
      amount: transactionAmount,
      dest: destinationRoutingParameters,
      clearingAccount,
    });

    const res = await this.sender.sendSettlement({
      tenantId,
      transactionAmount,
      clearingAccount,
      destinationRoutingParameters,
      splits: { feeTotal, netTotal },
    });

    if (!res.ok) throw new Error('NCBA_SETTLEMENT_SENDER_FAILED');

    return {
      confirmationId: stableHashHex({ bankReference: res.bankReference, txId }),
      tenantId,
      transactionId: txId,
      amount: transactionAmount,
      clearingAccount,
      routedTo: destinationRoutingParameters,
    };
  }
}
