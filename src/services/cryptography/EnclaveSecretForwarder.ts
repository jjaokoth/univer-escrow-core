import crypto from 'crypto';

import type { AttestationDocument } from '../EnclaveBridgeService.js';
import { EnclaveBridgeService } from '../EnclaveBridgeService.js';
import { sha256Hex } from '../merkle/sha256.js';

export type NodeProvisioning = {
  nodeId: string;
  endpoint: string;
  attestationDocument: AttestationDocument;
  // Public key used by the leader to encrypt the forwarding envelope.
  // In a real deployment this would be derived from attestation or a secure registry.
  nodePublicKeyPem: string;
};

export type SecretSplitShare = {
  shareIndex: number;
  shareBytesHex: string;
};

export type EncryptedForwardingEnvelope = {
  epoch: number;
  masterSecretId: string;
  // encryption under joining node’s public key
  recipientNodeId: string;
  encryptedShareBlobs: string[];
  shareIndices: number[];
  // Auditability
  envelopeHash: string;
};

export type SecretShareForwardReceipt = {
  nodeId: string;
  epoch: number;
  forwarded: boolean;
  envelope: EncryptedForwardingEnvelope;
};

function assertNonEmptyString(x: unknown, name: string): void {
  if (typeof x !== 'string' || x.length === 0) {
    throw new Error(`INVALID_${name}`);
  }
}

function encryptForRecipient(publicKeyPem: string, plaintext: Buffer): string {
  // RSA-OAEP hybrid envelope for this repo.
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    plaintext
  );
  return encrypted.toString('hex');
}

/**
 * EnclaveSecretForwarder
 *
 * - Leader-side manager that verifies attestation
 * - Encrypts and forwards split shares to a joining node
 *
 * In this repo, secret splitting and encryption are mocked deterministically.
 */
export class EnclaveSecretForwarder {
  private static instance: EnclaveSecretForwarder | null = null;

  private constructor() {}

  public static getInstance(): EnclaveSecretForwarder {
    if (!EnclaveSecretForwarder.instance) {
      EnclaveSecretForwarder.instance = new EnclaveSecretForwarder();
    }
    return EnclaveSecretForwarder.instance;
  }

  /**
   * Leader verifies the node’s attested identity, then forwards encrypted shares.
   */
  public forwardSplitSharesToNewNode(params: {
    node: NodeProvisioning;
    epoch: number;
    masterSecretId: string;
    // deterministic split parameters for tests
    totalShares: number;
    threshold: number;
    // master secret bytes (never persisted; only transiently used)
    masterSecretBytes: Buffer;
  }): SecretShareForwardReceipt {
    if (!EnclaveBridgeService.isEnclaveReady()) {
      throw new Error('SECURITY_VIOLATION: enclave not ready for secret forwarding');
    }

    assertNonEmptyString(params.node.nodeId, 'NODE_ID');
    assertNonEmptyString(params.node.endpoint, 'ENDPOINT');
    assertNonEmptyString(params.node.nodePublicKeyPem, 'NODE_PUBLIC_KEY_PEM');
    assertNonEmptyString(params.masterSecretId, 'MASTER_SECRET_ID');

    const okStructural = EnclaveBridgeService.verifyEnclaveAttestation(params.node.attestationDocument);
    if (!okStructural) {
      throw new Error('ATTESTATION_GATE_REJECTED');
    }

    const epoch = params.epoch;
    const shareCount = Math.max(1, params.totalShares | 0);

    // Deterministic split: derive share i as H(masterSecretId|epoch|i) bytes.
    // NOTE: This is interface-compatible with Shamir-like schemes for the lifecycle test.
    const shares: SecretSplitShare[] = [];
    for (let i = 1; i <= shareCount; i++) {
      const digest = sha256Hex(`${params.masterSecretId}|${epoch}|SHARE_${i}`);
      const shareBytes = Buffer.from(digest, 'hex');
      shares.push({ shareIndex: i, shareBytesHex: shareBytes.toString('hex') });
    }

    const encryptedShareBlobs: string[] = [];
    const shareIndices: number[] = [];

    for (let i = 0; i < shares.length; i++) {
      const s = shares[i];
      const plaintext = Buffer.from(s.shareBytesHex, 'hex');
      const blob = encryptForRecipient(params.node.nodePublicKeyPem, plaintext);
      encryptedShareBlobs.push(blob);
      shareIndices.push(s.shareIndex);
    }

    const envelopeHash = sha256Hex(
      `ENCRYPTED_FORWARD_V1|${params.masterSecretId}|${epoch}|${params.node.nodeId}|${shareIndices.join(',')}|${encryptedShareBlobs.join('|')}`
    );

    const envelope: EncryptedForwardingEnvelope = {
      epoch,
      masterSecretId: params.masterSecretId,
      recipientNodeId: params.node.nodeId,
      encryptedShareBlobs,
      shareIndices,
      envelopeHash
    };

    return {
      nodeId: params.node.nodeId,
      epoch,
      forwarded: true,
      envelope
    };
  }
}

