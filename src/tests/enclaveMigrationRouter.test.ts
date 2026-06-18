import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';

import { EnclaveSealingEngine } from '../services/cryptography/EnclaveSealingEngine.js';
import { EnclaveBridgeService } from '../services/EnclaveBridgeService.js';
import { DatabaseService } from '../services/DatabaseService.js';
import router from '../services/EscrowRouter.js';

type HttpResponse = {
  statusCode: number;
  body: any;
};

function rsaSha256HexSignature(data: string, privateKeyPem: string): string {
  const signer = crypto.createSign('sha256');
  signer.update(Buffer.from(data, 'utf8'));
  signer.end();
  return signer.sign(privateKeyPem).toString('hex');
}

function canonicalHeader(migrationId: string, metadata: { mrsigner: string; targetMrenclave: string }): string {
  return `migrationId=${migrationId}|mrsigner=${metadata.mrsigner}|targetMrenclave=${metadata.targetMrenclave}`;
}

function postJson(port: number, path: string, payload: unknown): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ statusCode: response.statusCode ?? 0, body: parsed });
        });
      }
    );

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function run(): Promise<void> {
  EnclaveBridgeService.setEnclaveReadyForTest?.(true);

  const cpuMasterSecret = 'cpu_master_secret_simulated';
  const mrsigner = 'mrsigner_authority_pkg_v1';
  const mrenclaveOld = 'mrenclave_measurement_old_v1';
  const mrenclaveNew = 'mrenclave_measurement_new_v2';

  DatabaseService.setActiveSealingContext({
    cpuMasterSecret,
    mrsigner,
    mrenclave: mrenclaveOld
  });

  const plaintext = Buffer.from('state_root_payload_for_migration', 'utf8');
  const engineOld = new EnclaveSealingEngine({
    cpuMasterSecret,
    mrsigner,
    mrenclave: mrenclaveOld
  });
  const oldBlob = engineOld.sealData(plaintext, 'MRENCLAVE');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const migrationId = 'mig_0001';
  const metadata = { mrsigner, targetMrenclave: mrenclaveNew };
  const canonical = canonicalHeader(migrationId, metadata);
  const packageSignatureHex = rsaSha256HexSignature(canonical, privateKey.toString());

  const app = express();
  app.use(express.json());
  app.use(router);

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err?: Error) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;

  const payload = {
    payload: {
      blob: oldBlob,
      metadata,
      migrationId,
      packageSignatureHex,
      packagePublicKeyPem: publicKey.toString()
    },
    trustedMRSIGNER: mrsigner,
    trustedPackagePublicKeyPem: publicKey.toString()
  };

  const resOk = await postJson(port, '/api/infrastructure/upgrade-state-enclave', payload);
  assert.strictEqual(resOk.statusCode, 200, 'Expected successful upgrade endpoint response');
  assert.ok(resOk.body?.newBlob, 'Expected migration endpoint to return a newBlob');

  const engineNew = new EnclaveSealingEngine({
    cpuMasterSecret,
    mrsigner,
    mrenclave: mrenclaveNew
  });
  const unsealed = engineNew.unsealData(resOk.body.newBlob);
  assert.strictEqual(unsealed.toString('utf8'), plaintext.toString('utf8'));

  const activeContext = DatabaseService.getActiveSealingContext();
  assert.strictEqual(activeContext?.mrenclave, mrenclaveNew, 'Active sealing context should update to new MRENCLAVE');

  const tamperedPayload = {
    ...payload,
    payload: {
      ...payload.payload,
      packageSignatureHex: packageSignatureHex.length > 2 ? '00' + packageSignatureHex.slice(2) : packageSignatureHex
    }
  };
  const resBadSig = await postJson(port, '/api/infrastructure/upgrade-state-enclave', tamperedPayload);
  assert.strictEqual(resBadSig.statusCode, 403, 'Expected tampered signature to be rejected');
  assert.ok(resBadSig.body?.error, 'Expected error message for tampered signature');

  const badAuthPayload = {
    payload: {
      blob: oldBlob,
      metadata: { mrsigner: 'evil_mrsigner', targetMrenclave: mrenclaveNew },
      migrationId,
      packageSignatureHex,
      packagePublicKeyPem: publicKey.toString()
    },
    trustedMRSIGNER: mrsigner,
    trustedPackagePublicKeyPem: publicKey.toString()
  };
  const resBadAuth = await postJson(port, '/api/infrastructure/upgrade-state-enclave', badAuthPayload);
  assert.strictEqual(resBadAuth.statusCode, 403, 'Expected wrong authority to be rejected');
  assert.ok(resBadAuth.body?.error, 'Expected error message for authority mismatch');

  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) return reject(err);
      resolve();
    });
  });

  plaintext.fill(0);
  console.log(JSON.stringify({ result: 'PASS', ts: new Date().toISOString() }));
}

run().catch((err) => {
  console.error(JSON.stringify({ result: 'FAIL', error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
