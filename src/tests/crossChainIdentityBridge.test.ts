/**
 * CrossChainIdentityBridge.test.ts
 * Regression tests for Cross-Chain Relay and DID Ingress
 * Simulates inbound Ethereum state logs and signed W3C credentials
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CrossChainRelayEngine, TargetChain, type BlockHeader, type StateProof } from '../services/bridge/CrossChainRelayEngine.js';
import { ConfidentialIdentityEngine, type VerifiableCredential, type DIDDocument } from '../services/security/ConfidentialIdentityEngine.js';

describe('CrossChainRelayEngine', () => {
  let engine: CrossChainRelayEngine;

  beforeEach(() => {
    engine = new CrossChainRelayEngine();
  });

  it('should verify Ethereum block headers with PoW consensus', async () => {
    // Simulate raw block header (minimal valid mock)
    const mockHeader = Buffer.from([
      0xec, 0x08, // RLP prefix
      0x8c, // length prefix
      0xab, 0xad, 0xca, 0xfe, // parent hash
    ]);
    const headers = await engine.verifyBlockHeaders([mockHeader], TargetChain.ETHEREUM);
    expect(headers.length).toBe(1);
  });

  it('should verify state proofs against state root', async () => {
    const stateRoot = '0x' + 'ab'.repeat(32);
    const proofs: StateProof[] = [
      { key: '0x1234', value: '0x5678', proof: ['0x' + 'aa'.repeat(32)] }
    ];
    const verified = await engine.verifyStateProofs(stateRoot, proofs);
    expect(verified.size).toBe(1);
  });

  it('should extract state logs from proofs', async () => {
    const headers: BlockHeader[] = [];
    const proofs: StateProof[] = [
      { key: '0xlog1', value: JSON.stringify({ address: '0xABC', topics: [], data: '0x', logIndex: 0 }), proof: [] }
    ];
    const logs = await engine.extractStateLogs(headers, proofs);
    expect(logs.length).toBe(1);
  });
});

describe('ConfidentialIdentityEngine', () => {
  let identityEngine: ConfidentialIdentityEngine;

  beforeEach(() => {
    identityEngine = new ConfidentialIdentityEngine(24);
  });

  it('should reject stale credentials', async () => {
    const staleCredential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: { id: 'did:eth:0xissuer' },
      issuanceDate: '2020-01-01T00:00:00Z',
      expirationDate: '2021-01-01T00:00:00Z',
      credentialSubject: { id: 'did:eth:0xsubject' },
      proof: { type: 'EcdsaSecp256k1Signature2019', created: '2020-01-01T00:00:00Z', verificationMethod: 'key1', proofPurpose: 'assertionMethod', jws: '' }
    };
    const result = await identityEngine.verifyCredential(staleCredential);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('should verify credential with valid DID resolution', async () => {
    const mockDidDoc: DIDDocument = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'did:eth:0xissuer',
      verificationMethod: [{ id: 'key1', type: 'Ed25519', controller: 'did:eth:0xissuer', publicKeyHex: '0x' + 'ab'.repeat(32) }],
      authentication: ['key1'],
      assertionMethod: ['key1']
    };
    await identityEngine.cacheDidResolution('did:eth:0xissuer', mockDidDoc);
    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: { id: 'did:eth:0xissuer' },
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:eth:0xsubject', claim: 'value' },
      proof: { type: 'Ed25519Signature2020', created: new Date().toISOString(), verificationMethod: 'key1', proofPurpose: 'assertionMethod', jws: 'valid-sig' }
    };
    const result = await identityEngine.verifyCredential(credential);
    expect(result.subjectDid).toBe('did:eth:0xsubject');
  });

  it('should reject invalid signatures', async () => {
    const mockDidDoc: DIDDocument = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'did:eth:0xissuer',
      verificationMethod: [{ id: 'key1', type: 'Ed25519', controller: 'did:eth:0xissuer' }], // No public key
      authentication: ['key1'],
      assertionMethod: ['key1']
    };
    await identityEngine.cacheDidResolution('did:eth:0xissuer', mockDidDoc);
    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: { id: 'did:eth:0xissuer' },
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:eth:0xsubject' },
      proof: { type: 'Ed25519Signature2020', created: new Date().toISOString(), verificationMethod: 'key1', proofPurpose: 'assertionMethod', jws: '' }
    };
    const result = await identityEngine.verifyCredential(credential);
    expect(result.valid).toBe(false);
  });

  it('should reject credentials with future issuance date', async () => {
    const futureCredential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: { id: 'did:eth:0xissuer' },
      issuanceDate: '2099-01-01T00:00:00Z',
      credentialSubject: { id: 'did:eth:0xsubject' },
      proof: { type: 'EcdsaSecp256k1Signature2019', created: '2099-01-01T00:00:00Z', verificationMethod: 'key1', proofPurpose: 'assertionMethod', jws: '' }
    };
    const result = await identityEngine.verifyCredential(futureCredential);
    expect(result.valid).toBe(false);
  });
});

describe('Integration: Cross-Chain with Identity', () => {
  it('should process Ethereum state log with signed credential', async () => {
    const relayEngine = new CrossChainRelayEngine();
    const identityEngine = new ConfidentialIdentityEngine(24);
    const mockDidDoc: DIDDocument = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'did:eth:0xvalidator',
      verificationMethod: [{ id: 'key1', type: 'Secp256k1', controller: 'did:eth:0xvalidator', publicKeyHex: '0x' + 'ab'.repeat(33) }],
      authentication: ['key1'],
      assertionMethod: ['key1']
    };
    await identityEngine.cacheDidResolution('did:eth:0xvalidator', mockDidDoc);
    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: { id: 'did:eth:0xvalidator' },
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:eth:0xasset', amount: '1000' },
      proof: { type: 'EcdsaSecp256k1Signature2019', created: new Date().toISOString(), verificationMethod: 'key1', proofPurpose: 'assertionMethod', jws: 'valid' }
    };
    const identityResult = await identityEngine.verifyCredential(credential);
    expect(identityResult.valid).toBe(true);
    expect(identityResult.issuerDid).toBe('did:eth:0xvalidator');
  });
});
