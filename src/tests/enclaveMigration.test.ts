import assert from 'assert';
import crypto from 'crypto';

import { EnclaveSealingEngine } from '../services/cryptography/EnclaveSealingEngine.js';
import { EnclaveMigrationManager } from '../services/infrastructure/EnclaveMigrationManager.js';
import { EnclaveBridgeService } from '../services/EnclaveBridgeService.js';

function rsaSha256HexSignature(data: string, privateKeyPem: string): string {
  const signer = crypto.createSign('sha256');
  signer.update(Buffer.from(data, 'utf8'));
  signer.end();
  return signer.sign(privateKeyPem).toString('hex');
}

function canonicalHeader(migrationId: string, metadata: { mrsigner: string; targetMrenclave: string }): string {
  return `migrationId=${migrationId}|mrsigner=${metadata.mrsigner}|targetMrenclave=${metadata.targetMrenclave}`;
}

async function run(): Promise<void> {
  // Ensure secure memory boundary is available.
  EnclaveBridgeService.setEnclaveReadyForTest?.(true);

  const cpuMasterSecret = 'cpu_master_secret_simulated';
  const mrsigner = 'mrsigner_authority_pkg_v1';
  const mrenclaveOld = 'mrenclave_measurement_old_v1';
  const mrenclaveNew = 'mrenclave_measurement_new_v2';

  const plaintext = Buffer.from('state_root_payload_for_migration', 'utf8');

  // Seal under old enclave measurement (policy MRENCLAVE).
  const engineOld = new EnclaveSealingEngine({ cpuMasterSecret, mrsigner, mrenclave: mrenclaveOld });
  const oldBlob = engineOld.sealData(plaintext, 'MRENCLAVE');

  // Build upgrade package metadata and RSA package signature.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const migrationId = 'mig_0001';
  const metadata = { mrsigner, targetMrenclave: mrenclaveNew };
  const canonical = canonicalHeader(migrationId, metadata);
  const packageSignatureHex = rsaSha256HexSignature(canonical, privateKey.toString());

  const manager = new EnclaveMigrationManager({ cpuMasterSecret, mrsigner, mrenclave: mrenclaveNew });

  // Happy path migration.
  const resOk = manager.migrateBlob({
    payload: {
      blob: oldBlob,
      metadata,
      migrationId,
      packageSignatureHex,
      packagePublicKeyPem: publicKey.toString()
    },
    trustedMRSIGNER: mrsigner,
    trustedPackagePublicKeyPem: publicKey.toString()
  });

  assert.strictEqual(resOk.ok, true, `expected migration ok, got ${(resOk as any).error}`);
  const newBlob = resOk.ok ? resOk.newBlob : (null as any);
  assert.ok(newBlob, 'expected newBlob');

  // Prove re-keying works: old plaintext can be unsealed only under new enclave measurement.
  const engineNew = new EnclaveSealingEngine({ cpuMasterSecret, mrsigner, mrenclave: mrenclaveNew });
  const unsealed = engineNew.unsealData(newBlob);
  assert.strictEqual(unsealed.toString('utf8'), plaintext.toString('utf8'), 'migration re-seal must preserve plaintext');

  // Fail-closed: unauthenticated/tampered signature must be blocked instantly.
  const tamperedSigHex = packageSignatureHex.length > 2 ? '00' + packageSignatureHex.slice(2) : packageSignatureHex;
  const resBadSig = manager.migrateBlob({
    payload: {
      blob: oldBlob,
      metadata,
      migrationId,
      packageSignatureHex: tamperedSigHex,
      packagePublicKeyPem: publicKey.toString()
    },
    trustedMRSIGNER: mrsigner,
    trustedPackagePublicKeyPem: publicKey.toString()
  });

  assert.strictEqual(resBadSig.ok, false, 'expected tampered signature to fail closed');

  // Fail-closed: wrong trusted authority must be blocked.
  const resBadAuth = manager.migrateBlob({
    payload: {
      blob: oldBlob,
      metadata: { mrsigner: 'evil_mrsigner', targetMrenclave: mrenclaveNew },
      migrationId,
      packageSignatureHex,
      packagePublicKeyPem: publicKey.toString()
    },
    trustedMRSIGNER: mrsigner,
    trustedPackagePublicKeyPem: publicKey.toString()
  });
  assert.strictEqual(resBadAuth.ok, false, 'expected authority mismatch to fail closed');

  // Scrub original plaintext for safety in test.
  plaintext.fill(0);

  console.log(JSON.stringify({ result: 'PASS', ts: new Date().toISOString() }));
}

run().catch((e) => {
  console.error(JSON.stringify({ result: 'FAIL', error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
});

