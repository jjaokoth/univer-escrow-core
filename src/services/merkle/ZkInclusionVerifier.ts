import type { HexDigest } from './types';

export type ZkInclusionProofMatrix = {
  siblings: HexDigest[];
  leftRight: Array<'L' | 'R'>;
  leafIndex: number;
  leafCount: number;
};

export type ZkInclusionReceipt = {
  verified: boolean;
  computedRootHash: HexDigest;
};

function isHexDigest(x: unknown): x is HexDigest {
  return typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x);
}

function failClosedReceipt(computedRootHash: HexDigest): ZkInclusionReceipt {
  return {
    verified: false,
    computedRootHash
  };
}

/**
 * Stateless verifier: reconstructs the Merkle path upward from a public leaf hash,
 * using sibling hashes + direction markers, and checks if the result equals the
 * public Merkle root.
 *
 * Note: This is a deterministic cryptographic inclusion gate ("ZK layout"), but it
 * does not implement full ZK circuits; it provides the same public interface the
 * enclave proof gate would feed into a real ZK backend.
 */
export class ZkInclusionVerifier {
  public static verify(params: {
    leafHash: HexDigest;
    merkleRootHash: HexDigest;
    proof: ZkInclusionProofMatrix;
  }): ZkInclusionReceipt {
    const { leafHash, merkleRootHash, proof } = params;

    if (!isHexDigest(leafHash) || !isHexDigest(merkleRootHash)) {
      // Fail-closed with deterministic placeholder root.
      const computedRootHash = merkleRootHash as HexDigest;
      return failClosedReceipt(computedRootHash);
    }

    if (!proof || !Array.isArray(proof.siblings) || !Array.isArray(proof.leftRight)) {
      return failClosedReceipt(merkleRootHash);
    }

    if (proof.siblings.length !== proof.leftRight.length) {
      return failClosedReceipt(merkleRootHash);
    }

    // Reconstruct using the same domain-separated MerkleNode hashing rule.
    // Static import ensures compile-safety under Node16/CommonJS + TS.
    const { sha256Hex } = require('./sha256');


    let hash: HexDigest = leafHash;

    // leftRight[level] indicates current hash is Left or Right child at that level.
    for (let level = 0; level < proof.siblings.length; level++) {
      const sibling = proof.siblings[level];
      const marker = proof.leftRight[level];

      if (!isHexDigest(sibling)) {
        return failClosedReceipt(merkleRootHash);
      }
      if (marker !== 'L' && marker !== 'R') {
        return failClosedReceipt(merkleRootHash);
      }

      if (marker === 'R') {
        // current is right child => hash is on right; sibling is left
        hash = sha256Hex(`MERKLE_NODE|${sibling}|${hash}`);
      } else {
        // current is left child
        hash = sha256Hex(`MERKLE_NODE|${hash}|${sibling}`);
      }
    }

    const computedRootHash = hash;
    return {
      verified: computedRootHash === merkleRootHash,
      computedRootHash
    };
  }
}

