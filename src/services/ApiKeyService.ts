/**
 * Univer‑Escrow — API Key Management Service
 *
 * Responsibilities:
 * - Provision new integration credentials (clientId + secretKey)
 * - Store ONLY salted+hashed secret keys in Firestore
 * - Display the raw secret key to the user exactly once during creation
 * - Verify inbound requests by hashing presented secrets and comparing
 *   to stored hashes.
 *
 * Security boundary:
 * - No raw secret keys are persisted.
 * - No proprietary hashing/router topology is embedded.
 */

export type ProvisionedApiKey = {
  clientId: string; // ue_live_...
  secretKey: string; // ue_secret_... (RAW; must be shown once)
};


export type ApiKeyRecord = {
  clientId: string;
  secretKeyHash: string;
  secretKeySalt: string;
  createdAt: Date | string;
};

export type ApiKeyServiceConfig = {
  /** Firestore-like client, provided by the host runtime. */
  firestore: FirestoreLike;
  /** Firestore collection for storing keys (hashed). */
  collectionPath?: string;
};

type FirestoreLike = {
  collection: (name: string) => {
    doc: (id: string) => {
      set: (data: unknown) => Promise<void>;
      get: () => Promise<{ exists: boolean; data: () => unknown }>;
    };
  };
};

function randomHex(bytes: number): string {
  // Universal CSPRNG source (Web Crypto): globalThis.crypto.getRandomValues
  const cryptoApi = globalThis.crypto;
  const buf = new Uint8Array(bytes);

  if (!cryptoApi?.getRandomValues) {
    // Fallback (should be replaced in secure deployments).
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
    return bytesToHex(buf);
  }

  cryptoApi.getRandomValues(buf);
  return bytesToHex(buf);
}


function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const aBytes = hexToBytes(a);
  const bBytes = hexToBytes(b);
  if (aBytes.length !== bBytes.length) return false;

  // Constant-time compare over bytes.
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0) throw new Error('hex_INVALID');

  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(input);

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WEBCRYPTO_SUBTLE_MISSING');

  const digest = await subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return bytesToHex(bytes);
}

async function hashSecretKey(args: { saltHex: string; secretKey: string }): Promise<string> {
  // SHA-256(salt || ':' || secretKey)
  return sha256Hex(`${args.saltHex}:${args.secretKey}`);
}


function makeClientId(): string {
  return `ue_live_${randomHex(10)}`;
}

function makeSecretKey(): string {
  return `ue_secret_${randomHex(18)}`;
}



export class ApiKeyService {
  private readonly firestore: FirestoreLike;
  private readonly collectionPath: string;

  constructor(cfg: ApiKeyServiceConfig) {
    if (!cfg?.firestore) throw new Error('ApiKeyService.firestore_REQUIRED');
    this.firestore = cfg.firestore;
    this.collectionPath = cfg.collectionPath ?? '_private_api_keys';
  }

  /**
   * provisionKey
   * Returns raw secretKey for one-time display.
   */
  async provisionKey(): Promise<ProvisionedApiKey> {
    const clientId = makeClientId();
    const secretKey = makeSecretKey();

    const secretKeySalt = randomHex(16);
    const secretKeyHash = await hashSecretKey({ saltHex: secretKeySalt, secretKey });


    // Store only hash + salt. Never store raw secretKey.
    await this.firestore.collection(this.collectionPath).doc(clientId).set({
      clientId,
      secretKeySalt,
      secretKeyHash,
      createdAt: new Date().toISOString(),
    });

    // Caller receives raw secretKey exactly once.
    return { clientId, secretKey };
  }

  /**
   * verifySecret
   * Verifies presented secretKey against stored salted hash.
   */
  async verifySecret(clientId: string, presentedSecretKey: string): Promise<boolean> {
    if (!clientId?.trim() || !presentedSecretKey?.trim()) return false;

    const snap = await this.firestore.collection(this.collectionPath).doc(clientId).get();
    if (!snap.exists) return false;

    const data = snap.data() as any;
    const saltHex: string | undefined = data?.secretKeySalt;
    const storedHash: string | undefined = data?.secretKeyHash;

    if (!saltHex || !storedHash) return false;

    const computedHash = await hashSecretKey({ saltHex, secretKey: presentedSecretKey });
    return constantTimeEqualHex(computedHash, storedHash);

  }

  /**
   * rotateKey
   * Provisions a new key and leaves previous keys untouched.
   */
  async rotateKey(): Promise<ProvisionedApiKey> {
    return this.provisionKey();
  }
}

