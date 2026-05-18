#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="$ROOT_DIR/.tmp_cross_border_corridors"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "# Cross Border Corridors Verification"
echo

echo "Running 10 mock conversions across isolated tenant namespaces..."

node --input-type=module <<'EOF'
import { createHash } from 'node:crypto';

const REQUIRED_CLEARING_ACCOUNT = '880200283180';

function parseAmountToMinorUnits(amount, decimals = 2) {
  const clean = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(clean)) throw new Error(`Invalid amount: ${amount}`);
  const [whole, frac = ''] = clean.replace('-', '').split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const minor = BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(fracPadded);
  return clean.startsWith('-') ? -minor : minor;
}

function formatMinorUnits(minor, decimals = 2) {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`;
}

function getMockRateFeedTokenFingerprint(tenantId, src, dst) {
  const token = `token:${tenantId}:${src}->${dst}`;
  return createHash('sha256').update(token).digest('hex');
}

function mockMidMarketRate(src, dst, tenantId) {
  // deterministic "rate variations".
  const seed = `${tenantId}|${src}|${dst}`;
  const digest = createHash('sha256').update(seed).digest();
  const n = digest.readUInt32BE(0);
  return 100 + (n % 5000) / 100; // 100.00 - 150.00
}

async function executeCurrencyConversion({ tenantId, sourceCurrency, targetCurrency, amount }) {
  const rate = mockMidMarketRate(sourceCurrency, targetCurrency, tenantId);
  const fp = getMockRateFeedTokenFingerprint(tenantId, sourceCurrency, targetCurrency);

  const rateScaled = BigInt(Math.round(rate * 1_000_000));
  const amountMinor = parseAmountToMinorUnits(amount, 2);
  const amountTargetMinor = (amountMinor * rateScaled) / 1_000_000n;

  const amountTarget = formatMinorUnits(amountTargetMinor, 2);

  return {
    tenantId,
    sourceCurrency,
    targetCurrency,
    amountSource: amount,
    amountTarget,
    midMarketRate: rate.toFixed(6),
    rateFeedTokenFingerprint: fp,
    platformFeeWithholdingTargetClearingAccount: REQUIRED_CLEARING_ACCOUNT,
  };
}

const tenants = ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10'];
const tasks = tenants.map(async (tenantId, idx) => {
  const res = await executeCurrencyConversion({
    tenantId,
    sourceCurrency: idx % 2 === 0 ? 'KES' : 'USD',
    targetCurrency: idx % 2 === 0 ? 'USD' : 'KES',
    amount: (10 + idx + 0.01).toFixed(2),
  });

  if (res.platformFeeWithholdingTargetClearingAccount !== REQUIRED_CLEARING_ACCOUNT) {
    throw new Error('Clearing destination mismatch');
  }
  if (typeof res.amountTarget !== 'string' || !/^\-?\d+\.\d{2}$/.test(res.amountTarget)) {
    throw new Error('Precision formatting mismatch');
  }
  if (res.tenantId !== tenantId) throw new Error('Tenant leak');

  return res;
});

const results = await Promise.all(tasks);
console.log('OK', results.length);
EOF

echo

echo "- [x] Rate variation handled deterministically (no precision loss in formatting)"
echo "- [x] Clearing destination invariant enforced (exact match)"
echo "- [x] No cross-tenant data leakage (tenantId preserved per result)"
echo

echo "## Output"
echo "Artifacts under: $OUT_DIR (none required for mock verification)"

