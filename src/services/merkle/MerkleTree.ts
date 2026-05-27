import type { HexDigest, MerkleProof } from './types';
import { sha256Hex } from './sha256';

// Deterministic binary Merkle tree.
// If there are not enough nodes at a level, we duplicate the last node hash.
// This matches standard 'duplicate last' Merkle tree behavior and supports inclusion proofs.
export class MerkleTree {
  private readonly leaves: readonly HexDigest[];
  private readonly layers: readonly HexDigest[][]; // layers[0]=leaves, last layer contains root

  constructor(leaves: readonly HexDigest[]) {
    this.leaves = leaves;

    if (this.leaves.length === 0) {
      // Define an empty-tree root deterministically.
      const emptyRoot = sha256Hex('');
      this.layers = [[emptyRoot]];
      return;
    }

    const built: HexDigest[][] = [];
    built.push([...this.leaves]);

    while (built[built.length - 1].length > 1) {
      const prev = built[built.length - 1];
      const next: HexDigest[] = [];

      for (let i = 0; i < prev.length; i += 2) {
        const left = prev[i];
        const right = prev[i + 1] ?? prev[i];
        // Domain separation: MerkleNode
        next.push(sha256Hex(`MERKLE_NODE|${left}|${right}`));
      }

      built.push(next);
    }

    this.layers = built;
  }

  public getLeafCount(): number {
    return this.leaves.length;
  }

  public getRoot(): HexDigest {
    const last = this.layers[this.layers.length - 1];
    return last[0];
  }

  /**
   * Generate an inclusion proof for a leaf.
   * The proof is the array of sibling hashes from leaf level upward.
   */
  public getProof(leafIndex: number): MerkleProof {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new RangeError('Invalid leafIndex for Merkle proof');
    }

    const siblings: HexDigest[] = [];
    let idx = leafIndex;

    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const isRightNode = idx % 2 === 1;
      const siblingIdx = isRightNode ? idx - 1 : idx + 1;
      const siblingHash = layer[siblingIdx] ?? layer[idx];
      siblings.push(siblingHash);
      idx = Math.floor(idx / 2);
    }

    return {
      siblings,
      leafIndex,
      leafCount: this.leaves.length
    };
  }

  /**
   * Deterministically compute root from leaf hash + proof.
   */
  public static verifyProof(params: {
    leafHash: HexDigest;
    proof: MerkleProof;
  }): HexDigest {
    const { leafHash, proof } = params;

    let hash = leafHash;
    let idx = proof.leafIndex;

    for (const sibling of proof.siblings) {
      const isRightNode = idx % 2 === 1;
      if (isRightNode) {
        // hash is right
        hash = sha256Hex(`MERKLE_NODE|${sibling}|${hash}`);
      } else {
        // hash is left
        hash = sha256Hex(`MERKLE_NODE|${hash}|${sibling}`);
      }
      idx = Math.floor(idx / 2);
    }

    return hash;
  }
}

