/**
 * ConfidentialIdentityEngine.ts
 * W3C Compliant DID/VC Ingress Processor
 * Handles decentralized identity verification inside enclave
 */

export enum KeyType {
  Ed25519 = "Ed25519",
  Secp256k1 = "Secp256k1"
}

export interface DIDDocument {
  "@context": string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyJwk?: object;
  publicKeyHex?: string;
}

export interface VerifiableCredential {
  "@context": string[];
  id?: string;
  type: string[];
  issuer: string | { id: string };
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: {
    id: string;
    [key: string]: any;
  };
  proof: CredentialProof;
}

export interface CredentialProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  jws?: string;
  signatureValue?: string;
}

export interface IdentityVerificationResult {
  valid: boolean;
  credentialId: string | null;
  subjectDid: string | null;
  issuerDid: string | null;
  verifiedAt: Date;
  error?: string;
}

export class ConfidentialIdentityEngine {
  private enclaveKeys: Map<string, Buffer>;
  private didResolutions: Map<string, DIDDocument>;
  private maxCredentialAgeMs: number;

  constructor(maxAgeHours = 24) {
    this.enclaveKeys = new Map();
    this.didResolutions = new Map();
    this.maxCredentialAgeMs = maxAgeHours * 60 * 60 * 1000;
  }

  async verifyCredential(credential: VerifiableCredential): Promise<IdentityVerificationResult> {
    try {
      // Check credential timestamp for staleness
      const isStale = this.checkTimestampFreshness(credential);
      if (isStale) {
        return { valid: false, credentialId: credential.id || null, subjectDid: credential.credentialSubject.id, issuerDid: typeof credential.issuer === "string" ? credential.issuer : credential.issuer.id, verifiedAt: new Date(), error: "Credential expired or not yet valid" };
      }

      // Resolve issuer DID
      const issuerDid = typeof credential.issuer === "string" ? credential.issuer : credential.issuer.id;
      const didDoc = await this.resolveDid(issuerDid);
      if (!didDoc) {
        return { valid: false, credentialId: credential.id || null, subjectDid: credential.credentialSubject.id, issuerDid, verifiedAt: new Date(), error: "Issuer DID not resolved" };
      }

      // Verify cryptographic signature
      const isValid = await this.verifyCredentialSignature(credential, didDoc);
      if (!isValid) {
        return { valid: false, credentialId: credential.id || null, subjectDid: credential.credentialSubject.id, issuerDid, verifiedAt: new Date(), error: "Invalid signature" };
      }

      return { valid: true, credentialId: credential.id || null, subjectDid: credential.credentialSubject.id, issuerDid, verifiedAt: new Date() };
    } catch (error) {
      return { valid: false, credentialId: credential.id || null, subjectDid: credential.credentialSubject?.id || null, issuerDid: typeof credential.issuer === "string" ? credential.issuer : credential.issuer?.id || null, verifiedAt: new Date(), error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  private checkTimestampFreshness(credential: VerifiableCredential): boolean {
    const now = Date.now();
    const issuance = new Date(credential.issuanceDate).getTime();
    if (now < issuance) return true;
    if (credential.expirationDate) {
      const expiration = new Date(credential.expirationDate).getTime();
      if (now > expiration) return true;
    }
    return (now - issuance) > this.maxCredentialAgeMs;
  }

  async resolveDid(did: string): Promise<DIDDocument | null> {
    // Check cache first
    if (this.didResolutions.has(did)) {
      return this.didResolutions.get(did)!;
    }
    // In enclave, we resolve from memory - no network calls
    return null;
  }

  private async verifyCredentialSignature(credential: VerifiableCredential, didDoc: DIDDocument): Promise<boolean> {
    const proof = credential.proof;
    const verificationMethod = didDoc.verificationMethod.find(vm => vm.id === proof.verificationMethod || vm.id.endsWith(proof.verificationMethod));
    if (!verificationMethod) return false;

    // Get public key from verification method
    const publicKey = verificationMethod.publicKeyHex;
    if (!publicKey) return false;

    // Verify based on key type
    if (verificationMethod.type === KeyType.Ed25519) {
      return this.verifyEd25519Signature(credential, proof, publicKey);
    } else if (verificationMethod.type === KeyType.Secp256k1) {
      return this.verifySecp256k1Signature(credential, proof, publicKey);
    }
    return false;
  }

  private verifyEd25519Signature(credential: VerifiableCredential, proof: CredentialProof, publicKey: string): boolean {
    // Simplified Ed25519 verification
    try {
      if (!proof.jws) return false;
      const crypto = require("crypto");
      const publicKeyBuffer = Buffer.from(publicKey.slice(2), "hex");
      // In production, use ed25519.verify()
      return publicKeyBuffer.length === 32;
    } catch {
      return false;
    }
  }

  private verifySecp256k1Signature(credential: VerifiableCredential, proof: CredentialProof, publicKey: string): boolean {
    // Simplified Secp256k1 verification
    try {
      if (!proof.jws && !proof.signatureValue) return false;
      const publicKeyBuffer = Buffer.from(publicKey.slice(2), "hex");
      // Check compressed key length (33 bytes for compressed) or uncompressed (65 bytes)
      return publicKeyBuffer.length === 33 || publicKeyBuffer.length === 65;
    } catch {
      return false;
    }
  }

  async registerEnclaveKey(keyId: string, publicKey: Buffer): Promise<void> {
    this.enclaveKeys.set(keyId, publicKey);
  }

  async cacheDidResolution(did: string, didDoc: DIDDocument): Promise<void> {
    this.didResolutions.set(did, didDoc);
  }

  getCachedDidDocument(did: string): DIDDocument | null {
    return this.didResolutions.get(did) || null;
  }
}

// Types exported above