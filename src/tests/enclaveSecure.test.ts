import assert from 'assert';
import { generateKeyPairSync, createSign } from 'crypto';
import { EnclaveBridgeService, type AttestationDocument } from '../services/EnclaveBridgeService.js';

function rsaSha256HexSignature(data: string, privateKeyPem: string): string {
  const signer = createSign('sha256');
  signer.update(Buffer.from(data, 'utf8'));
  signer.end();
  return signer.sign(privateKeyPem).toString('hex');
}

type ScrubHook = {
  scrubbedBytes: number;
};

async function run(): Promise<void> {
  // 1) Fail-closed: verification without attestation must throw.
  EnclaveBridgeService.revokeEnclaveState();

  let threw = false;
  try {
    EnclaveBridgeService.verifySignatureInEnclave('tenant:acct:1', '00', '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----');
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, true, 'expected enclave execution to fail-closed without attestation');

  // 2) Attestation success path.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const pcr0 = '8f3c1b2a4e5d6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7a8b9c0d1e';
  const pcr1 = 'boot-runtime-param';
  const canonicalManifest = `${pcr0}:${pcr1}`;
  const attSigHex = rsaSha256HexSignature(canonicalManifest, privateKey.toString());

  const doc: AttestationDocument = {
    pcr0,
    pcr1,
    signature: attSigHex,
    hsmPublicKey: publicKey.toString()
  };

  const ok = EnclaveBridgeService.verifyEnclaveAttestation(doc);
  assert.strictEqual(ok, true, 'expected attestation verification to succeed');
  assert.strictEqual(EnclaveBridgeService.isEnclaveReady(), true, 'expected enclaveReady=true after valid attestation');

  // 3) Signature verification + scrubbing.
  const payload = 'tenant_alpha:acc_0x123:5000';
  const validationString = payload;

  // Generate signing key for CryptoService verification.
  const { publicKey: appPublic, privateKey: appPrivate } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const sigHex = rsaSha256HexSignature(validationString, appPrivate.toString());

  const before = EnclaveBridgeService.lastScrubbedByteLength;
  const verified = EnclaveBridgeService.verifySignatureInEnclave(validationString, sigHex, appPublic.toString());
  assert.strictEqual(verified, true, 'expected signature verification to succeed');

  const scrubbedBytes = EnclaveBridgeService.lastScrubbedByteLength;
  const hook: ScrubHook = { scrubbedBytes };
  assert.ok(hook.scrubbedBytes > 0, 'expected scrubbing hook to record >0 bytes');
  assert.notStrictEqual(scrubbedBytes, before, 'expected scrubbing hook to change after operation');

  // 4) Attestation failure must revoke state.
  EnclaveBridgeService.revokeEnclaveState();
  const badDoc: AttestationDocument = { ...doc, pcr0: '0'.repeat(doc.pcr0.length) };
  const badOk = EnclaveBridgeService.verifyEnclaveAttestation(badDoc);
  assert.strictEqual(badOk, false, 'expected invalid attestation to fail');
  assert.strictEqual(EnclaveBridgeService.isEnclaveReady(), false, 'expected enclaveReady=false after invalid attestation');

  console.log(JSON.stringify({ result: 'PASS', ts: new Date().toISOString(), scrubbedBytes: hook.scrubbedBytes }));
}

run().catch((err) => {
  console.error(JSON.stringify({ result: 'FAIL', error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});

