import { EnclaveTimeAnchorService, type SignedTimeAssertion } from '../services/consensus/EnclaveTimeAnchorService.js';
import { EnclaveBridgeService } from '../services/EnclaveBridgeService.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function makeAssertion(nodeId: string, assertedAtMs: number, pcr0Hash: string): SignedTimeAssertion {
  // Signature mock matches EnclaveTimeAnchorService.verifySignatureMock.
  // We must mirror its stableStringify input.
  const payload = {
    nodeId,
    assertedAtMs,
    pcr0Hash,
    validUntilMs: null
  };

  // Inline stable stringify algorithm to avoid importing internals.
  const stable = (value: any): string => {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number' || t === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (t === 'object') {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((obj as any)[k])}`).join(',')}}`;
    }
    return JSON.stringify(String(value));
  };

  const crypto = require('crypto') as typeof import('crypto');
  const canonical = stable(payload);
  const sig = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');

  return {
    nodeId,
    assertedAtMs,
    pcr0Hash,
    signature: sig
  };
}

export async function runEnclaveTimeAnchorRegression(): Promise<void> {
  // Enable enclave ready.
  (EnclaveBridgeService as any).enclaveReady = true;

  const svc = EnclaveTimeAnchorService.getInstance();
  svc.reset();

  const base = 1_700_000_000_000; // deterministic pseudo-now
  const pcr0Hash = 'pcr0_token_placeholder';

  // Honest nodes around base.
  const a1 = makeAssertion('node_A', base + 800, pcr0Hash);
  const a2 = makeAssertion('node_B', base - 900, pcr0Hash);
  const a3 = makeAssertion('node_C', base + 1200, pcr0Hash);

  // Malicious node reports a rollback time far outside ±5s median threshold.
  const rollback = base - 60_000;
  const aMal = makeAssertion('node_MAL', rollback, pcr0Hash);

  // Ingest all assertions.
  const r1 = svc.ingestAssertion(a1);
  const r2 = svc.ingestAssertion(a2);
  const r3 = svc.ingestAssertion(a3);
  const rM = svc.ingestAssertion(aMal);

  assert(r1.ok && r2.ok && r3.ok && rM.ok, 'Expected all assertions structurally valid for ingestion.');

  const computed = svc.computeMedianAnchor({ requiredMinAssertions: 3 });
  assert(computed.ok === true, 'Expected median anchor computation to succeed.');
  assert(!!computed.anchor, 'Expected computed anchor to be present.');

  const anchorMs = computed.anchor!.anchorMs;
  const included = computed.anchor!.includedNodeIds;

  // Malicious node must be outlier.
  assert(!included.includes('node_MAL'), 'Expected malicious rollback node to be filtered as outlier.');

  // Time-locked transaction window.
  // validAfter should be > rolled-back time, but <= median anchor.
  const validAfterMs = rollback + 10_000; // still before honest anchor
  const validUntilMs = anchorMs + 60_000;

  const okUnderAnchor = EnclaveBridgeService.verifyTimeLocksInEnclave({
    validAfterMs,
    validUntilMs,
    quorumMedianAnchorMs: anchorMs
  });

  assert(okUnderAnchor === true, 'Expected transaction to pass time-lock evaluation using quorum median anchor.');

  // Simulate host time-travel: if enclave incorrectly used host time (rollback), it would fail.
  const hostRollbackMs = rollback;
  const okUnderHostRollback = EnclaveBridgeService.verifyTimeLocksInEnclave({
    validAfterMs,
    validUntilMs,
    quorumMedianAnchorMs: hostRollbackMs
  });

  assert(okUnderHostRollback === false, 'Expected fail-closed: host rollback time must not satisfy quorum median gate.');
}

if (require.main === module) {
  runEnclaveTimeAnchorRegression()
    .then(() => {
      console.log('✅ enclaveTimeAnchor regression passed');
      process.exit(0);
    })
    .catch((e) => {
      console.error('❌ enclaveTimeAnchor regression failed:', e);
      process.exit(1);
    });
}

