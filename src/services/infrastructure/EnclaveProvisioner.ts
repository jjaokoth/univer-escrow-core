import type { AttestationDocument } from '../EnclaveBridgeService.js';
import { AttestationFactory } from './AttestationFactory.js';

export type ProvisioningProfile = {
  nodeId: string;
  listenPort: number;
  // Mocked vsock/vbridge matrix identifiers.
  vsockEndpoint: string;
  // Measurement surrogates used by the attestation factory.
  pcr0: string;
  pcr1: string;
  // Minimal runtime memory isolation limit for tests.
  memoryMbLimit: number;
};

export type ProvisionedGuest = {
  profile: ProvisioningProfile;
  attestation: AttestationDocument;
};

/**
 * EnclaveProvisioner
 *
 * Production intent:
 * - orchestrate ephemeral confidential-compute instance creation
 * - configure isolated networking (vsock / internal bridge)
 * - start guest runtime with memory isolation
 * - inject env vars without spilling secrets into host shell history
 *
 * In-repo implementation:
 * - provides deterministic mock provisioning used by regression tests
 */
export class EnclaveProvisioner {
  public static provisionEphemeralConfidentialNode(inputs: {
    nodeId: string;
    listenPort: number;
    pcr0: string;
    pcr1: string;
    memoryMbLimit?: number;
  }): ProvisionedGuest {
    const memoryMbLimit = Number.isFinite(inputs.memoryMbLimit as number)
      ? Number(inputs.memoryMbLimit)
      : 256;

    // In production, vsockEndpoint would be derived from VM/Enclave IDs.
    // For this repo test harness, keep deterministic.
    const vsockEndpoint = `vsock://localhost:${inputs.listenPort}`;

    const profile: ProvisioningProfile = {
      nodeId: inputs.nodeId,
      listenPort: inputs.listenPort,
      vsockEndpoint,
      pcr0: inputs.pcr0,
      pcr1: inputs.pcr1,
      memoryMbLimit
    };

    // Guest boot -> generate attestation token.
    const { doc } = AttestationFactory.createAttestationDocument({
      nodeId: inputs.nodeId,
      pcr0: inputs.pcr0,
      pcr1: inputs.pcr1
    });

    return { profile, attestation: doc };
  }

  /**
   * Helper for tests; creates an invalid measurement profile.
   */
  public static provisionInvalidGuest(inputs: {
    nodeId: string;
    listenPort: number;
  }): ProvisionedGuest {
    const badPcr0 = '0'.repeat(64);
    const badPcr1 = 'invalid-config';

    return EnclaveProvisioner.provisionEphemeralConfidentialNode({
      nodeId: inputs.nodeId,
      listenPort: inputs.listenPort,
      pcr0: badPcr0,
      pcr1: badPcr1
    });
  }
}

