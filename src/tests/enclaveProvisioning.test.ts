import assert from 'assert';
import { EnclaveClusterService } from '../services/consensus/EnclaveClusterService.js';
import { EnclaveBridgeService, type AttestationDocument } from '../services/EnclaveBridgeService.js';
import { EnclaveProvisioner } from '../services/infrastructure/EnclaveProvisioner.js';
import { AttestationFactory } from '../services/infrastructure/AttestationFactory.js';

// We will call the join gate logic through the router handler in EscrowRouter.
// EscrowRouter exports an express.Router; we can locate the route handler by path.
import { EscrowRouter } from '../services/EscrowRouter.js';

function findPostHandler(router: any, path: string): ((req: any, res: any) => any) | null {
  const stack = router?.stack ?? [];
  for (const layer of stack) {
    if (layer?.route?.path === path && layer?.route?.methods?.post) {
      const handler = layer.route.stack?.[0]?.handle;
      if (typeof handler === 'function') return handler;
    }
  }
  return null;
}

function mockRes() {
  const out: any = { statusCode: 200, body: undefined };
  return {
    status(code: number) {
      out.statusCode = code;
      return this;
    },
    json(payload: any) {
      out.body = payload;
      return out;
    },
    get _out() {
      return out;
    }
  };
}

async function run(): Promise<void> {
  EnclaveClusterService.clearClusterTopology();
  EnclaveBridgeService.revokeEnclaveState();

  // Ensure enclaveReady state is irrelevant for PCR measurement gate.
  EnclaveBridgeService.setEnclaveReadyForTest(true);

  const joinHandler = findPostHandler(EscrowRouter, '/api/infrastructure/join-cluster')
    ?? findPostHandler(EscrowRouter, '/api/infrastructure/join-cluster/:anything');

  assert(joinHandler, 'Expected join-cluster handler to be registered on EscrowRouter');

  const baseline = AttestationFactory.getBaselineTemplate();

  // 1) Valid guest joins.
  const nodeIdOk = 'node_ok_1';
  const listenPort = 7777;

  const provisionedOk = EnclaveProvisioner.provisionEphemeralConfidentialNode({
    nodeId: nodeIdOk,
    listenPort,
    pcr0: baseline.expectedPcr0,
    pcr1: baseline.expectedPcr1,
    memoryMbLimit: 256
  });

  // Sanity: attestation must be structurally verifiable by EnclaveBridgeService.
  const okStructural: boolean = EnclaveBridgeService.verifyEnclaveAttestation(provisionedOk.attestation);
  assert.strictEqual(okStructural, true, 'Expected structurally valid attestation');

  const reqOk = {
    body: {
      nodeId: nodeIdOk,
      attestationDocument: provisionedOk.attestation
    }
  };

  const resOk = mockRes();
  await joinHandler(reqOk, resOk);

  assert.strictEqual(resOk._out.statusCode, 200, 'Expected join success');

  const peersAfter = EnclaveClusterService.getAttestedPeers();
  assert(peersAfter.some((p) => p.nodeId === nodeIdOk), 'Expected node to be present in attested peers');

  // 2) Invalid guest is rejected and not blacklisted (at least not added).
  EnclaveClusterService.clearClusterTopology();

  const nodeIdBad = 'node_bad_1';
  const provisionedBad = EnclaveProvisioner.provisionEphemeralConfidentialNode({
    nodeId: nodeIdBad,
    listenPort,
    pcr0: 'bad_pcr0',
    pcr1: 'bad_pcr1',
    memoryMbLimit: 256
  });

  const badStructural = EnclaveBridgeService.verifyEnclaveAttestation(provisionedBad.attestation);
  // In the mock bridge, attestation should fail structural verification because pcr0 won't match expected.
  assert.strictEqual(badStructural, false, 'Expected structurally invalid attestation');

  const reqBad = {
    body: {
      nodeId: nodeIdBad,
      attestationDocument: provisionedBad.attestation
    }
  };

  const resBad = mockRes();
  await joinHandler(reqBad, resBad);

  assert.strictEqual(resBad._out.statusCode, 403, 'Expected join rejection');
  const peersAfterBad = EnclaveClusterService.getAttestedPeers();
  assert(!peersAfterBad.some((p) => p.nodeId === nodeIdBad), 'Expected invalid node not to be added');

  console.log(JSON.stringify({ result: 'PASS', ts: new Date().toISOString() }));
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ result: 'FAIL', error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});

