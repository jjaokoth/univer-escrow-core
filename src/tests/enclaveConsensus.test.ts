import { EnclaveClusterService } from '../services/consensus/EnclaveClusterService.js';
import { EnclaveRaftEngine } from '../services/consensus/EnclaveRaftEngine.js';
import { EnclaveBridgeService, type AttestationDocument } from '../services/EnclaveBridgeService.js';
import type { EscrowRecord } from '../services/DatabaseService.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/**
 * Enclave consensus regression (simulated multi-enclave raft plane).
 *
 * - Registers attested peers; malformed attestation must be rejected.
 * - Simulates leader append flow.
 * - Confirms that quorum failure forces fail-closed ledger drop.
 */
export async function runEnclaveConsensusRegression(): Promise<void> {
  // Fail-closed must be in effect.
  const raft = EnclaveRaftEngine.getInstance();
  raft.resetEngine();
  raft.failClosed = true;

  // Enable enclave ready for deterministic tests.
  (EnclaveBridgeService as any).enclaveReady = true;

  EnclaveClusterService.clearClusterTopology();

  // EnclaveBridgeService.verifyEnclaveAttestation requires a valid signature
  // over `${pcr0}:${pcr1}` and a strict PCR0 match to its expected value.
  // For this deterministic regression, we stub the attestation gate.
  const validAttestation: AttestationDocument = {
    pcr0: '8f3c1b2a4e5d6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7a8b9c0d1e',
    pcr1: '0'.repeat(64),
    signature: 'ignored',
    hsmPublicKey: 'ignored'
  };

  const invalidAttestation: AttestationDocument = {
    pcr0: 'MALICIOUS_TAMPERED_PCR0',
    pcr1: '0'.repeat(64),
    signature: 'ignored',
    hsmPublicKey: 'ignored'
  };

  // Stub: treat only PCR0-matching documents as valid.
  const verifySpy = jestLikeStubVerifyEnclaveAttestation(validAttestation);

  function jestLikeStubVerifyEnclaveAttestation(valid: AttestationDocument): () => void {
    const orig = EnclaveBridgeService.verifyEnclaveAttestation;
    (EnclaveBridgeService as any).verifyEnclaveAttestation = (doc: AttestationDocument) => doc?.pcr0 === valid.pcr0;
    return () => {
      (EnclaveBridgeService as any).verifyEnclaveAttestation = orig;
    };
  }


  // Register 2 valid peers => cluster size 3.
  const ok1 = EnclaveClusterService.registerPeer('enclave_node_2', 'http://10.0.0.2:8080', validAttestation);
  const ok2 = EnclaveClusterService.registerPeer('enclave_node_3', 'http://10.0.0.3:8080', validAttestation);
  const okRogue = EnclaveClusterService.registerPeer('rogue_node', 'http://10.0.0.9:8080', invalidAttestation);

  assert(ok1 === true, 'Expected peer 2 to register with valid attestation');
  assert(ok2 === true, 'Expected peer 3 to register with valid attestation');
  assert(okRogue === false, 'Expected rogue peer to be rejected with invalid attestation');

  const clusterSize = EnclaveClusterService.getClusterSize();
  assert(clusterSize === 3, `Expected cluster size 3, got ${clusterSize}`);

  // Create a deterministic escrow record.
  const record: EscrowRecord = {
    transactionId: 'tx_enclave_consensus_test_00000001',
    escrowRecordLeafHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    signature: 'rsa_signature',
    status: 'LOCKED',
    validAfterMs: 0,
    validUntilMs: 9999999999999,
    timestamp: new Date().toISOString()
  };

  // Leader staging.
  raft.currentRole = 'LEADER' as any;
  raft.currentTerm = 1;
  const entry = raft.appendLocalLog(record);

  // Quorum failure scenario: only 1 ack out of 3.
  const quorumTooThin = {
    ackCount: 1,
    clusterSize,
    acknowledgments: ['sig_1']
  };

  const resThin = await raft.commitToLedgerIfQuorum(entry.index, quorumTooThin);
  assert(resThin.committed === false, 'Expected fail-closed: thin quorum must not commit');
  assert(raft.commitIndex === 0, 'Expected commitIndex to remain 0 after quorum failure');

  // Quorum success scenario: 2 ack out of 3.
  const quorumOk = {
    ackCount: 2,
    clusterSize,
    acknowledgments: ['sig_1', 'sig_2']
  };

  const resOk = await raft.commitToLedgerIfQuorum(entry.index, quorumOk);
  assert(resOk.committed === true, 'Expected commit after quorum satisfied');
  assert(raft.commitIndex === entry.index, 'Expected commitIndex to update to committed entry index');
}

if (require.main === module) {
  runEnclaveConsensusRegression()
    .then(() => {
      console.log('✅ enclaveConsensus regression passed');
      process.exit(0);
    })
    .catch((e) => {
      console.error('❌ enclaveConsensus regression failed:', e);
      process.exit(1);
    });
}

