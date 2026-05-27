export type HexDigest = string & { readonly __brand: 'HexDigest' };

export type MerkleLevel = number;

export interface MerkleProof {
  /**
   * Sibling hashes from bottom (leaf level) to just below the root.
   * Length is deterministic for a given tree height.
   */
  siblings: HexDigest[];
  /**
   * Index of the leaf (0-based) in the leaf array used to build the tree.
   */
  leafIndex: number;
  /**
   * Number of leaves used to build the tree.
   */
  leafCount: number;
}

