import { EnclaveBridgeService, type AttestationDocument } from '../EnclaveBridgeService.js';

export interface ClusterPeer {
  nodeId: string;
  endpoint: string;
  isAttested: boolean;
}

/**
 * EnclaveClusterService
 *
 * Attestation-gated peer discovery broker for the synchronization ring.
 */
export class EnclaveClusterService {
  private static peers: Map<string, ClusterPeer> = new Map();

  public static registerPeer(
    nodeId: string,
    endpoint: string,
    attestation: AttestationDocument
  ): boolean {
    const ok = EnclaveBridgeService.verifyEnclaveAttestation(attestation);
    if (!ok) return false;

    this.peers.set(nodeId, {
      nodeId,
      endpoint,
      isAttested: true
    });

    return true;
  }

  public static clearClusterTopology(): void {
    this.peers.clear();
  }

  public static getClusterSize(): number {
    // +1 for local node.
    return this.peers.size + 1;
  }

  public static getAttestedPeers(): ClusterPeer[] {
    return Array.from(this.peers.values());
  }
}

