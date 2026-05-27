import type { HexDigest, MerkleProof } from './types';
import { MerkleTree } from './MerkleTree';
import { sha256Hex } from './sha256';
import { escrowRecordLeafHash } from './ledgerMerkle';
import { DatabaseService } from '../DatabaseService';
import type { EscrowRecord } from '../DatabaseService';

/**
 * Deterministic Merkle Root + inclusion proof generator for the escrow ledger.
 *
 * This implementation is intentionally simple/fail-closed: it rebuilds the tree from
 * active ledger records and uses the repository's internal SHA256 + MerkleTree
 * domain separation.
 */
export class EnclaveMerkleAccumulator {
  private cachedRoot: HexDigest | null = null;
  private cachedLeafCount: number | null = null;
  private cachedAt: string | null = null;
  private cachedProofsByTxId: Map<string, { leafHash: HexDigest; proof: MerkleProof }> | null = null;

  constructor() {}

  private async buildFromLedger(): Promise<{
    root: HexDigest;
    tree: MerkleTree;
    leaves: readonly HexDigest[];
    proofByTxId: Map<string, { leafHash: HexDigest; proof: MerkleProof }>;
    leafCount: number;
    snapshotFingerprint: HexDigest;
  }> {
    const records: readonly EscrowRecord[] = await DatabaseService.getAllRecords();
    const leaves: HexDigest[] = records.map(escrowRecordLeafHash);

    const tree = new MerkleTree(leaves);
    const root = tree.getRoot();

    const proofByTxId = new Map<string, { leafHash: HexDigest; proof: MerkleProof }>();
    for (let i = 0; i < records.length; i++) {
      proofByTxId.set(records[i].transactionId, {
        leafHash: leaves[i],
        proof: tree.getProof(i)
      });
    }

    // Deterministic snapshot fingerprint so we can cache per-commit.
    const snapshotFingerprint = sha256Hex(JSON.stringify({
      root,
      leafCount: tree.getLeafCount()
    }));

    return {
      root,
      tree,
      leaves,
      proofByTxId,
      leafCount: tree.getLeafCount(),
      snapshotFingerprint
    };
  }

  public async getRootHash(): Promise<HexDigest> {
    const { root, leafCount, snapshotFingerprint } = await this.buildFromLedger();
    if (
      this.cachedRoot &&
      this.cachedLeafCount !== null &&
      this.cachedAt &&
      this.cachedAt === snapshotFingerprint
    ) {
      return this.cachedRoot;
    }

    this.cachedRoot = root;
    this.cachedLeafCount = leafCount;
    this.cachedAt = snapshotFingerprint;

    const built = await this.buildFromLedger();
    this.cachedProofsByTxId = built.proofByTxId;

    return root;
  }

  /**
   * Returns a succinct inclusion proof matrix:
   * - `siblings`: sibling hashes from bottom to just below root
   * - `leftRight`: markers per level ('L' means current hash is left child, sibling is right)
   * - `leafIndex` and `leafCount` are included for deterministic verification.
   */
  public async getInclusionProof(transactionId: string): Promise<{
    merkleRootHash: HexDigest;
    leafHash: HexDigest;
    proof: {
      siblings: HexDigest[];
      leftRight: Array<'L' | 'R'>;
      leafIndex: number;
      leafCount: number;
    };
  }> {
    if (!transactionId || typeof transactionId !== 'string') {
      throw new TypeError('transactionId must be a non-empty string');
    }

    const built = await this.buildFromLedger();

    const hit = built.proofByTxId.get(transactionId);
    if (!hit) {
      throw new Error('TRANSACTION_NOT_FOUND');
    }

    const { proof } = hit;

    // Derive left/right markers from the deterministic leafIndex + sibling list length.
    const leftRight: Array<'L' | 'R'> = [];
    let idx = proof.leafIndex;
    for (let level = 0; level < proof.siblings.length; level++) {
      const isRightNode = idx % 2 === 1;
      // Current node position relative to sibling
      leftRight.push(isRightNode ? 'R' : 'L');
      idx = Math.floor(idx / 2);
    }

    return {
      merkleRootHash: built.root,
      leafHash: hit.leafHash,
      proof: {
        siblings: proof.siblings,
        leftRight,
        leafIndex: proof.leafIndex,
        leafCount: proof.leafCount
      }
    };
  }
}

