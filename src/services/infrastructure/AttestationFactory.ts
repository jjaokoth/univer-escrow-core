import { generateKeyPairSync, createSign } from 'crypto';
import type { AttestationDocument } from '../EnclaveBridgeService.js';

export type AttestationInputs = {
  nodeId: string;
  pcr0: string;
  pcr1: string;
};

export type AttestationFactoryResult = {
  doc: AttestationDocument;
  nodeId: string;
};

function canonicalManifest(doc: Pick<AttestationDocument, 'pcr0' | 'pcr1'>): string {
  return `${doc.pcr0}:${doc.pcr1}`;
}

function rsaSha256HexSignature(data: string, privateKeyPem: string): string {
  const signer = createSign('sha256');
  signer.update(Buffer.from(data, 'utf8'));
  signer.end();
  return signer.sign(privateKeyPem).toString('hex');
}

/**
 * AttestationFactory
 *
 * Mock implementation of a confidential-compute remote attestation workflow.
 *
 * - Measures code/config state as PCR0/PCR1 surrogates
 * - Generates an ephemeral asymmetric keypair (RSA for compatibility with EnclaveBridgeService mock verifier)
 * - Produces a signed AttestationDocument
 */
export class AttestationFactory {
  public static createAttestationDocument(inputs: AttestationInputs): AttestationFactoryResult {
    const { nodeId, pcr0, pcr1 } = inputs;

    // Ephemeral asymmetric keypair bound to this attestation document.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const canonical = canonicalManifest({ pcr0, pcr1 });
    const signatureHex = rsaSha256HexSignature(canonical, privateKey.toString());

    const doc: AttestationDocument = {
      pcr0,
      pcr1,
      signature: signatureHex,
      // EnclaveBridgeService uses the provided hsmPublicKey as the trust root in its mock verification.
      hsmPublicKey: publicKey.toString()
    };

    return { doc, nodeId };
  }

  public static getBaselineTemplate(): { expectedPcr0: string; expectedPcr1: string } {
    // These must match the expectations enforced in EnclaveBridgeService.verifyEnclaveAttestation.
    // EnclaveBridgeService hard-codes expectedPcr0 and compares doc.pcr0 exactly.
    const expectedPcr0 = '8f3c1b2a4e5d6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7a8b9c0d1e';
    // We treat baseline PCR1 as an exact match too (requirement: template exact equality).
    // This repo uses arbitrary values in tests; keep baseline aligned with typical expected values.
    const expectedPcr1 = 'boot-runtime-param';

    return { expectedPcr0, expectedPcr1 };
  }
}

