/*
Universal Payout Router (TypeScript)

Purpose:
Decide whether to send funds to M-Pesa, a Bank Account, or a Crypto Wallet based on destination_type.

Ghost-ready requirements covered:
- Idempotency: payout_request_key unique constraint + get-or-create logic.
- Deterministic payload building.
- Provider dispatch is isolated behind interfaces.
- Structured KRA/eTIMS logging hooks.

This file is framework-agnostic; it expects a Prisma client and provider adapters.
*/

import type { Prisma, PrismaClient } from "@prisma/client";

export enum DestinationType {
  M_PESA = "M_PESA",
  BANK_ACCOUNT = "BANK_ACCOUNT",
  CRYPTO_WALLET = "CRYPTO_WALLET",
}


export type MinorAmount = bigint;

export interface PayoutRouterInput {
  escrowId: string;
  tenantId?: string;
  userId?: string;

  destinationType: DestinationType;
  currency: "KES" | "USD" | "USDC";
  amountMinor: MinorAmount;
  destinationRef: string;

  /// Idempotency key from caller (router-level). Can be a hash of: delivery_verification_id + amount + destination_ref
  payoutRequestKey: string;

  /// For audit
  actorId?: string;
  actorType?: string;
}

export interface ProviderDispatchResult {
  providerName: string;
  providerRef: string;
}

export interface MPesaProvider {
  dispatchPayout(args: {
    tenantId?: string;
    userId?: string;
    escrowId: string;
    destinationRef: string;
    amountMinor: MinorAmount;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderDispatchResult>;
}

export interface BankProvider {
  dispatchPayout(args: {
    tenantId?: string;
    userId?: string;
    escrowId: string;
    destinationRef: string;
    amountMinor: MinorAmount;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderDispatchResult>;
}

export interface CryptoProvider {
  dispatchPayout(args: {
    tenantId?: string;
    userId?: string;
    escrowId: string;
    destinationRef: string;
    amountMinor: MinorAmount;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderDispatchResult>;
}

export interface LedgerHasher {
  // Hash-chain helper for immutable ledger events
  hash(input: string): Promise<string>;
}

export interface KratimsLogger {
  info(obj: Record<string, unknown>): void;
  warn(obj: Record<string, unknown>): void;
  error(obj: Record<string, unknown>): void;
}

export interface RouterDeps {
  prisma: PrismaClient;
  logger: KratimsLogger;
  mpesaProvider: MPesaProvider;
  bankProvider: BankProvider;
  cryptoProvider: CryptoProvider;
  ledgerHasher?: LedgerHasher;
}

type RouteOutcome =
  | { status: "DISPATCHED"; payoutId: string; providerName: string; providerRef: string; created: boolean }
  | { status: "ALREADY_DISPATCHED"; payoutId: string; created: false };

function assertNever(x: never): never {
  throw new Error(`Unhandled destination type: ${String(x)}`);
}

function mapCurrencyForProvider(currency: string): string {
  // Extend as needed (e.g., USDC base units vs display units)
  return currency;
}

async function getLatestLedgerHash(prisma: PrismaClient, escrowId: string): Promise<string | null> {
  const latest = await prisma.ledgerEvent.findFirst({
    where: { escrow_id: escrowId },
    orderBy: { created_at: "desc" },
    select: { event_hash: true },
  });
  return latest?.event_hash ?? null;
}

export async function universalPayoutRouter(deps: RouterDeps, input: PayoutRouterInput): Promise<RouteOutcome> {
  const {
    prisma,
    logger,
    mpesaProvider,
    bankProvider,
    cryptoProvider,
    ledgerHasher,
  } = deps;

  let provider: MPesaProvider | BankProvider | CryptoProvider;
  let providerName: string;

  switch (input.destinationType) {
    case DestinationType.M_PESA:
      provider = mpesaProvider;
      providerName = "daraja_3_0";
      break;
    case DestinationType.BANK_ACCOUNT:
      provider = bankProvider;
      providerName = "stripe_connect_bank";
      break;
    case DestinationType.CRYPTO_WALLET:
      provider = cryptoProvider;
      providerName = "circle_programmable_wallets";
      break;
    default:
      return assertNever(input.destinationType as never);
  }


  const { escrowId, tenantId, userId, actorId, actorType } = input;

  logger.info({
    kind: "router.invoke",
    component: "universal-payout-router",
    event_ts: new Date().toISOString(),
    tenant_id: tenantId ?? null,
    user_id: userId ?? null,
    escrow_id: escrowId,
    payout_request_key: input.payoutRequestKey,
    destination_type: input.destinationType,
    currency: input.currency,
    amount_minor: input.amountMinor.toString(),
    actor_id: actorId ?? null,
    actor_type: actorType ?? null,
    // KRA/eTIMS fields stub (must be standardized in your logging middleware)
    etims: {
      kra_tax_year: null,
      form_code: "ETIMS_PAYOUT",
      transaction_direction: "OUT",
      correlation_id: input.payoutRequestKey,
    },
  });

  // Idempotent get-or-create payout
  // This relies on Payout.payout_request_key being UNIQUE in Prisma schema.
  const payoutRow = await prisma.$transaction(async (tx) => {
    // tx is implicitly typed by Prisma in a real project.
    // Keep this file framework-agnostic; avoid "noImplicitAny" issues.
    const existing = await (tx as any).payout.findUnique({
      where: { payout_request_key: input.payoutRequestKey },
    });


    if (existing) return { payout: existing, created: false as const };

    // Create payout row
    const created = await (tx as any).payout.create({
      data: {
        escrow_id: escrowId,
        destination_type: input.destinationType,
        currency: input.currency as any,
        amount_minor: input.amountMinor,
        destination_ref: input.destinationRef,
        payout_request_key: input.payoutRequestKey,
        status: "CREATED",
      },
    });


    return { payout: created, created: true as const };
  });

  // If payout already exists, check if it has been dispatched.
  if (!payoutRow.created) {
    const already = await prisma.ledgerEvent.findFirst({
      where: {
        escrow_id: escrowId,
        payout_id: payoutRow.payout.id,
        event_type: "PAYOUT_DISPATCHED" as any,
      },
      orderBy: { created_at: "desc" },
    });

    if (already) {
      logger.info({
        kind: "router.already_dispatched",
        component: "universal-payout-router",
        correlation_id: input.payoutRequestKey,
        escrow_id: escrowId,
        payout_id: payoutRow.payout.id,
        destination_type: input.destinationType,
        provider_name: already.payload ? (already.payload as any).provider_name ?? null : null,
        provider_ref: already.payload ? (already.payload as any).provider_ref ?? null : null,
      });

      return { status: "ALREADY_DISPATCHED", payoutId: payoutRow.payout.id, created: false };
    }
  }

  // Dispatch based on type
  const idempotencyKey = input.payoutRequestKey;
  const providerArgsBase = {
    tenantId,
    userId,
    escrowId,
    destinationRef: input.destinationRef,
    amountMinor: input.amountMinor,
    currency: mapCurrencyForProvider(input.currency),
    idempotencyKey,
  };

  let dispatch: ProviderDispatchResult;
  switch (input.destinationType) {
    case DestinationType.M_PESA:
      dispatch = await (provider as MPesaProvider).dispatchPayout(providerArgsBase as any);
      break;
    case DestinationType.BANK_ACCOUNT:
      dispatch = await (provider as BankProvider).dispatchPayout(providerArgsBase as any);
      break;
    case DestinationType.CRYPT0_WALLET:
      dispatch = await (provider as CryptoProvider).dispatchPayout(providerArgsBase as any);
      break;
    default:
      assertNever(input.destinationType as never);
  }

  // Append ledger event (immutable)
  const previousHash = await getLatestLedgerHash(prisma, escrowId);

  const eventPayload = {
    provider_name: dispatch.providerName,
    provider_ref: dispatch.providerRef,
    destination_ref: input.destinationRef,
    destination_type: input.destinationType,
    amount_minor: input.amountMinor.toString(),
    currency: input.currency,
    idempotency_key: input.payoutRequestKey,
  };

  const eventHash = ledgerHasher
    ? await ledgerHasher.hash(JSON.stringify({ escrowId, eventPayload, previousHash }))
    : await (async () => {
        // Fallback non-crypto hash placeholder; replace in production
        const s = `${escrowId}|${JSON.stringify(eventPayload)}|${previousHash ?? "null"}`;
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return `0x${h.toString(16)}`;
      })();

  await prisma.$transaction(async (tx) => {
    const ledgerEventKey = `${escrowId}:PAYOUT_DISPATCHED:${input.payoutRequestKey}`;

    await (tx as any).ledgerEvent.create({
      data: {
        ledger_event_key: ledgerEventKey,
        escrow_id: escrowId,
        payout_id: payoutRow.payout.id,
        event_type: "PAYOUT_DISPATCHED" as any,
        currency: input.currency as any,
        amount_minor: input.amountMinor,
        payload: eventPayload,
        previous_hash: previousHash,
        event_hash: eventHash,
        tenant_id: tenantId,
        actor_id: actorId,
        actor_type: actorType,
      },
    });

    await (tx as any).payout.update({
      where: { id: payoutRow.payout.id },
      data: {
        status: "DISPATCHED",
        provider_name: dispatch.providerName,
        provider_ref: dispatch.providerRef,
      },
    });
  });


  logger.info({
    kind: "router.dispatched",
    component: "universal-payout-router",
    correlation_id: input.payoutRequestKey,
    escrow_id: escrowId,
    payout_id: payoutRow.payout.id,
    provider_name: dispatch.providerName,
    provider_ref: dispatch.providerRef,
    destination_type: input.destinationType,
  });

  return {
    status: "DISPATCHED",
    payoutId: payoutRow.payout.id,
    providerName: dispatch.providerName,
    providerRef: dispatch.providerRef,
    created: payoutRow.created,
  };
}

