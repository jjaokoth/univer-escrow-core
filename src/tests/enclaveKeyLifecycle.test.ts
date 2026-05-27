import { EnclaveKeyRotator } from '../services/cryptography/EnclaveKeyRotator.js';
import { EnclaveSecretForwarder } from '../services/cryptography/EnclaveSecretForwarder.js';
import { EnclaveRecoveryEngine } from '../services/cryptography/EnclaveRecoveryEngine.js';
import { EnclaveBridgeService, type AttestationDocument } from '../services/EnclaveBridgeService.js';
import { AttestationFactory } from '../services/infrastructure/AttestationFactory.js';
import { sha256Hex } from '../services/merkle/sha256.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function mkMasterSecretBytes(masterSecretId: string): Buffer {
  return Buffer.from(sha256Hex(`MASTER_SECRET_INPUT_V1|${masterSecretId}`), 'hex');
}

function mkProvision(nodeId: string, attestationDocument: AttestationDocument, nodePublicKeyPem: string) {
  return {
    nodeId,
    endpoint: `vsock://internal/${nodeId}`,
    attestationDocument,
    nodePublicKeyPem
  };
}

export async function runEnclaveKeyLifecycleRegression(): Promise<void> {
  // Force enclave boundary for deterministic lifecycle harness.
  EnclaveBridgeService.setEnclaveReadyForTest(true);
  assert(EnclaveBridgeService.isEnclaveReady(), 'Enclave must be ready');

  const rotator = EnclaveKeyRotator.getInstance();
  const forwarder = EnclaveSecretForwarder.getInstance();
  const recovery = EnclaveRecoveryEngine.getInstance();

  const prevEpoch = rotator.getCurrentEpoch();

  const receipt = rotator.triggerEpochRotation();
  assert(receipt.prevEpoch === prevEpoch, 'Rotation receipt prevEpoch mismatch');
  assert(receipt.nextEpoch === prevEpoch + 1, 'Rotation receipt nextEpoch mismatch');

  // Join newly provisioned node.
  const masterSecretId = 'ledger-verify-secret-v1';
  const epoch = receipt.nextEpoch;
  const threshold = 3;
  const totalShares = 4;

  const baseline = AttestationFactory.getBaselineTemplate();

  // Build attestation docs for leader verification.
  const p1 = AttestationFactory.createAttestationDocument({
    nodeId: 'node_join',
    pcr0: baseline.expectedPcr0,
    pcr1: baseline.expectedPcr1
  });

  // Node public key PEM is produced inside attestation document; reuse attestation doc hsmPublicKey as trust root.
  // For repo mock encryption, any valid PEM works; we will create a fresh RSA key via AttestationFactory.
  const joinProvision = mkProvision(
    'node_join',
    p1.doc,
    p1.doc.hsmPublicKey
  );

  const masterSecretBytes = mkMasterSecretBytes(masterSecretId);

  const forwardReceipt = forwarder.forwardSplitSharesToNewNode({
    node: joinProvision,
    epoch,
    masterSecretId,
    totalShares,
    threshold,
    masterSecretBytes
  });

  assert(forwardReceipt.forwarded === true, 'Expected forwarding');
  assert(forwardReceipt.envelope.epoch === epoch, 'Envelope epoch mismatch');
  assert(forwardReceipt.envelope.encryptedShareBlobs.length === totalShares, 'Share blob count mismatch');

  // Simulate cold recovery after total cluster power failure:
  // - clear in-memory enclave state
  // - require independently reconstructed nodes to provide plaintext shares.
  // In this repo, we simulate reconstructed shares by deterministically recomputing shareBytesHex
  // (since the forwarder share-splitting is deterministic over masterSecretId/epoch/index).
  EnclaveBridgeService.revokeEnclaveState();
  assert(!EnclaveBridgeService.isEnclaveReady(), 'Enclave revoked for reboot simulation');

  // After reboot, enclave becomes ready again once attested.
  EnclaveBridgeService.setEnclaveReadyForTest(true);

  const reconstructedShares = [] as any[];
  for (let i = 1; i <= threshold; i++) {
    const nodeId = `node_reconstructed_${i}`;
    const shareIndex = i;
    const shareBytesHex = sha256Hex(`${masterSecretId}|${epoch}|SHARE_${i}`);
    reconstructedShares.push({
      nodeId,
      shareIndex,
      shareBytesHex
    });
  }

  const recoveryReceipt = recovery.recoverMasterSecretFromShares({
    epoch,
    masterSecretId,
    threshold,
    shares: reconstructedShares
  });

  assert(recoveryReceipt.recovered === true, 'Recovery should succeed');
  assert(!!recoveryReceipt.reconstructedMasterSecretHex, 'Expected reconstructed master secret');

  // Verify cold recovery audit hash exists.
  assert(
    typeof recoveryReceipt.recoveryAuditHash === 'string' && recoveryReceipt.recoveryAuditHash.length > 0,
    'Recovery audit hash must exist'
  );
}

if (require.main === module) {
  runEnclaveKeyLifecycleRegression()
    .then(() => {
      console.log('✅ enclaveKeyLifecycle regression passed');
      process.exit(0);
    })
    .catch((e) => {
      console.error('❌ enclaveKeyLifecycle regression failed:', e);
      process.exit(1);
    });
}

