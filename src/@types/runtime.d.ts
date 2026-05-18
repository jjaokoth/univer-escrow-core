/*
 * Univer-Escrow Runtime Typing Overrides (Isomorphic)
 *
 * This file provides minimal, host-agnostic TypeScript contracts for
 * data adapters used by Univer-Escrow core modules.
 */

export type TransactionLike = {
  /* Optional host identifier */
  id?: string;
};

export type DocumentSnapshotLike<T = unknown> = {
  exists: boolean;
  data: () => T;
};

export type DocumentReferenceLike<T = unknown> = {
  set: (data: T) => Promise<void>;
  get: () => Promise<DocumentSnapshotLike<T>>;
};

export type CollectionReferenceLike<T = unknown> = {
  doc: (id: string) => DocumentReferenceLike<T>;
};

export type DataStoreLike<T = unknown> = {
  collection: (name: string) => CollectionReferenceLike<T>;
};

/*
 * Crypto/Encoding runtime assumptions:
 * - Web Crypto API: globalThis.crypto.subtle
 * - TextEncoder/TextDecoder: standard Web APIs
 */

export type WebCryptoSubtle = SubtleCrypto;

