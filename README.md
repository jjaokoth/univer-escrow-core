# Universal Trust Layer (UTL)

A production-grade multi-enclave Byzantine Fault Tolerant (BFT) ledger core with hardware-attestation-bound secret injection, VSOCK multiplexed communication channels, and zero-knowledge Merkle tree accumulators.

Designed for deployment in AWS Nitro Enclaves, GCP Confidential Space, and Azure Confidential VMs.

## Why Universal Trust Layer?

Traditional ledgers assume a trusted host administrator. UTL does not.

- **Memory-isolated execution** prevents exposure of transaction logs to compromised hypervisors
- **Hardware-bound sealing** ensures secrets only decrypt inside verified enclaves
- **2f+1 BFT consensus** tolerates up to f Byzantine nodes while maintaining correctness
- **Rolling Merkle compaction** prevents unbounded state growth and OOM crashes

### Three Pillars of Security

| Pillar | Description | Implementation |
| --- | --- | --- |
| **Confidentiality** | Memory-isolated runtime shielding | EnclaveSealingEngine with AES-256-GCM, HKDF key derivation bound to PCR measurements |
| **Integrity** | BFT consensus + ZK Merkle accumulator | EnclaveBftVerifyEngine (2f+1 threshold), EnclaveMerkleAccumulator with ZkInclusionVerifier |
| **Resilience** | Dynamic membership eviction + compaction | EnclaveClusterService (Raft-based), MerkleCompactor with rolling snapshots |

## Quick Start

```bash
git clone https://github.com/yourorg/universal-trust-layer.git
cd universal-trust-layer
npm install
npm run build:package
npm test
```

For detailed developer instructions, see [Developer Quick-Start](#developer-quick-start).

---

## Architecture

### Directory Structure

```
universal-trust-layer/
├── src/
│   ├── index.ts                 # Master bootstrapper with attestation flow
│   ├── server.ts               # Express server entry point
│   ├── middleware/
│   │   ├── AntiDosMiddleware.ts      # Rate limiting with PoW challenge
│   │   ├── LogShieldMiddleware.ts    # Structured audit logging
│   │   └── IntegrityMiddleware.ts  # Request signing verification
│   ├── services/
│   │   ├── cryptography/
│   │   │   ├── EnclaveSealingEngine.ts    # Hardware-bound sealing (AES-256-GCM)
│   │   │   ├── EnclaveKeyRotator.ts    # Automated key rotation
│   │   │   └── EnclaveSecretForwarder.ts # Secure inter-enclave messaging
│   │   ├── consensus/
│   │   │   ├── EnclaveBftVerifyEngine.ts    # 2f+1 Byzantine fault tolerance
│   │   │   ├── EnclaveRaftEngine.ts      # Raft leader election
│   │   │   └── EnclaveClusterService.ts # Dynamic membership management
│   │   ├── merkle/
│   │   │   ├── EnclaveMerkleAccumulator.ts # ZK-enabled Merkle tree
│   │   │   ├── MerkleCompactor.ts        # Rolling state compaction
│   │   │   └── ZkInclusionVerifier.ts  # Zero-knowledge proofs
│   │   ├── security/
│   │   │   ├── EnclaveLogShield.ts      # Tamper-evident audit logs
│   │   │   └── EnclaveErrors.ts       # Fail-closed error handling
│   │   └── infrastructure/
│   │       ├── AttestationFactory.ts   # Hardware attestation
│   │       └── EnclaveProvisioner.ts # Enclave lifecycle
│   └── tests/
│       ├── enclaveBftVerify.test.ts    # BFT consensus tests
│       ├── enclaveMerkleAudit.test.ts   # Merkle accumulator tests
│       └── productionLaunchSandbox.test.ts # E2E regression
├── scripts/
│   ├── build-enclave-image.sh     # EIF compilation with PCR output
│   ├── build-package.sh        # Dual target build (ESM + CJS)
│   └── bootstrap-runtime.sh    # Runtime initialization
├── Dockerfile                   # Multi-stage production build
└── package.json
```

### Key Modules

| Module | Purpose |
| --- | --- |
| **VsockBridgeAdapter** | AF_VSOCK channel multiplexer for host-enclave communication |
| **MerkleCompactor** | Rolling Merkle tree compaction to prevent unbounded state growth |
| **EnclaveLogShield** | Tamper-evident audit logging with cryptographic chaining |
| **EnclaveSealingEngine** | Hardware-bound secret sealing using PCR measurements |
| **EnclaveBftVerifyEngine** | 2f+1 Byzantine Fault Tolerant consensus verification |

## Developer Quick-Start

### Prerequisites

- Node.js 18+
- Docker (for containerized builds)
- AWS Nitro CLI (optional, for EIF builds)

### 1. Install Dependencies

```bash
npm install
```

### 2. Build Dual Targets

```bash
# Builds both ESM and CommonJS
npm run build:package

# Or build individually:
npm run build:esm
npm run build:cjs
```

### 3. Run Tests

```bash
# All tests
npm test

# Specific test file
npx vitest run src/tests/productionLaunchSandbox.test.ts
```

### 4. Verify Build Artifacts

```bash
ls -la dist/esm/
ls -la dist/cjs/
```

## Confidential Deployment

### Building the Production Image

```bash
docker build -t universal-trust-layer:1.0.0 -f Dockerfile .
```

### Generating EIF and PCR Verification

```bash
# Build EIF (requires AWS Nitro CLI)
IMAGE_NAME=universal-trust-layer IMAGE_TAG=1.0.0 ./scripts/build-enclave-image.sh

# View attestation metadata
cat enclave-output/enclave-attestation.json
```

> **PCR Matrix**: The script outputs PCR0 (Image ID), PCR1 (Runtime Code), and PCR2 (Environment) hashes. Use these to verify enclave integrity in production.

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `ENCLAVE_MRSIGNER` | Enclave signer measurement | (required) |
| `ENCLAVE_MRENCLAVE` | Enclave image measurement | (required) |
| `NODE_ENV` | Runtime environment | `production` |
| `LISTEN_PORT` | Server port | `8080` |
| `KMS_ENDPOINT` | External KMS for secrets | (optional) |

## Security

See [SECURITY.md](SECURITY.md) for vulnerability disclosure and response policies.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

---

**Version**: 1.0.0
**Last Updated**: 2024
