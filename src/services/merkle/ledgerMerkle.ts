import type { HexDigest, MerkleProof } from './types';
import { MerkleTree } from './MerkleTree';
import { sha256HexFromJsonStable } from './sha256';
import type { EscrowRecord } from '../DatabaseService';

// Leaf hash definition (deterministic, domain separated).
export function escrowRecordLeafHash(record: EscrowRecord): HexDigest {
  // For shielded ledger mode, the persistent leaf is the precomputed commitment.
  // Preserve domain separation by hashing a stable wrapper.
  const normalized = {
    transactionId: record.transactionId,
    escrowRecordLeafHash: record.escrowRecordLeafHash,
    signature: record.signature,
    status: record.status,
    timestamp: record.timestamp
  };

  return sha256HexFromJsonStable({ domain: 'ESCROW_LEDGER_LEAF', v: normalized });
}

export function buildMerkleForLedger(records: readonly EscrowRecord[]): {
  tree: MerkleTree;
  root: HexDigest;
  proofByTransactionId: Map<string, { proof: MerkleProof; leafHash: HexDigest }>;
} {
  const leaves: HexDigest[] = records.map(escrowRecordLeafHash);
  const tree = new MerkleTree(leaves);
  const root = tree.getRoot();

  const proofByTransactionId = new Map<string, { proof: MerkleProof; leafHash: HexDigest }>();
  for (let i = 0; i < records.length; i++) {
    proofByTransactionId.set(records[i].transactionId, {
      proof: tree.getProof(i),
      leafHash: leaves[i]
    });
  }

  return { tree, root, proofByTransactionId };
}

