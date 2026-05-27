// Repository placeholder for CI security-gate PQC hybrid rejection test.
//
// This project currently includes a mock lattice/PQC verification layer in
// src/services/merkle/pqcEngine.ts and enclaveSecure.test.ts covers fail-closed
// behavior.
//
// The security-gate matrix expects dist/tests/pqcHybrid.test.js to exist.
// This test is intentionally minimal and deterministic.

import { EnclaveBridgeService } from '../services/EnclaveBridgeService.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

export async function runPqcHybridGateRegression(): Promise<void> {
  // Ensure enclave is ready to exercise verification code paths.
  (EnclaveBridgeService as any).enclaveReady = true;

  // Malformed signatures should fail-closed.
  const ok = EnclaveBridgeService.verifyHybridSignatureInEnclave(
    'payload_not_real',
    {
      classicalSignature: '00',
      pqcSignature: '',
      classicalPublicKeyPem: '-----BEGIN PUBLIC KEY-----\n00\n-----END PUBLIC KEY-----',
      pqcPublicKeyToken: ''
    }
  );

  // verifyHybridSignatureInEnclave returns boolean; fail-closed on missing PQC fields.
  assert(ok === false, 'Expected PQC hybrid verification to reject malformed inputs.');
}

// If invoked directly via node dist/tests/pqcHybrid.test.js
if (require.main === module) {
  runPqcHybridGateRegression()
    .then(() => {
      console.log('✅ pqcHybrid regression passed');
      process.exit(0);
    })
    .catch((e) => {
      console.error('❌ pqcHybrid regression failed:', e);
      process.exit(1);
    });
}

