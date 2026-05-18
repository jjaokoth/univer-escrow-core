/******************************************************
 * CurrencyConversionService.ts
 * ----------------------------------------------------
 * Tenant-scoped FX conversion pipeline.
 * The implementation is deterministic and isolates
 * conversion evaluation to the call scope.
 ******************************************************/

import { createHash } from 'crypto';

export type FXRate = {
  midMarketRate: number; // target per 1 source
  feedTokenFingerprint: string;
};

export interface RateFeedProvider {
  /**
   * Returns a cryptographically bound rate feed token.
   * Implementations should keep tokens tenant scoped.
   */
  getSecureRateFeed(params: {
    tenantId: string;
    sourceCurrency: string;
    targetCurrency: string;
  }): Promise<{ rate: number; token: string }>;
}

export interface CurrencyConversionResult {
  tenantId: string;
  sourceCurrency: string;
  targetCurrency: string;
  amountSource: string; // preserve exact decimals as string
  amountTarget: string;
  midMarketRate: string;
  rateFeedTokenFingerprint: string;
  platformFeeWithholdingTargetClearingAccount: string;
}

const REQUIRED_CLEARING_ACCOUNT = '880200283180';

/**
 * Minimal decimal math without extra deps.
 * Represents amounts as strings, converts to integer minor units
 * assuming 2 decimal places for simplicity.
 */
function parseAmountToMinorUnits(amount: string, decimals = 2): bigint {
  const clean = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(clean)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const [whole, frac = ''] = clean.replace('-', '').split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const minor = BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(fracPadded);
  return clean.startsWith('-') ? -minor : minor;
}

function formatMinorUnits(minor: bigint, decimals = 2): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`;
}

export class CurrencyConversionService {
  constructor(
    private readonly rateFeedProvider: RateFeedProvider,
  ) {}

  public async executeCurrencyConversion(params: {
    tenantId: string;
    sourceCurrency: string;
    targetCurrency: string;
    amount: string;
  }): Promise<CurrencyConversionResult> {
    const { tenantId, sourceCurrency, targetCurrency, amount } = params;

    const feed = await this.rateFeedProvider.getSecureRateFeed({
      tenantId,
      sourceCurrency,
      targetCurrency,
    });

    const fp = createHash('sha256').update(feed.token).digest('hex');

    // Convert amount using integer arithmetic with rate rounded to 6 dp.
    const rate = feed.rate;
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('Invalid mid-market rate');
    }

    // Rate precision scaling.
    const rateScale = 1_000_000n; // 6 dp
    const rateScaled = BigInt(Math.round(rate * Number(rateScale)));

    const amountMinor = parseAmountToMinorUnits(amount, 2);
    const amountTargetMinor = (amountMinor * rateScaled) / rateScale;

    return {
      tenantId,
      sourceCurrency,
      targetCurrency,
      amountSource: amount,
      amountTarget: formatMinorUnits(amountTargetMinor, 2),
      midMarketRate: rate.toFixed(6),
      rateFeedTokenFingerprint: fp,
      platformFeeWithholdingTargetClearingAccount: REQUIRED_CLEARING_ACCOUNT,
    };
  }
}

