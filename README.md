# Universal Trust Layer — Public Investor Blueprint & Prototype Simulation Framework

## Executive Value Proposition
The **Universal Trust Layer (UTL)** is a production-oriented transaction lifecycle architecture designed to help enterprises operate financial automation with **multi-tenant isolation**, **cross-platform mobile keychain drivers**, and **hardened non-root container deployment models**.

UTL is engineered to reduce operational and compliance risk by combining three core guarantees:

1. **Multi-tenant isolation by construction**
   - Tenant-bound state is handled in isolated runtime environments.
   - Runtime data structures are explicitly separated to prevent cross-tenant leakage.
   - The architecture assumes hostile or malformed tenant traffic and validates boundaries before any settlement routing logic becomes effective.

2. **Cross-platform mobile signing & secure ingress verification**
   - Mobile gateway operations retrieve signing material via the platform keychain interface.
   - Payload integrity is demonstrated via **out-of-band dynamic HMAC verification** so that transit does not become the trust anchor.
   - The simulation blueprint shows how cryptographic markers can be attached upstream without coupling trust to in-path network behavior.

3. **Hardened non-root containers with minimal runtime footprints**
   - Production containers follow a multi-stage build pattern.
   - Build-time artifacts are discarded at compilation boundaries.
   - Runtime containers operate with **non-root posture** to harden privilege escalation vectors.

This repository therefore serves as a public demonstration framework: it provides **auditable documentation**, an **interactive prototype simulator**, and a **CI verification workflow** aligned to investor-grade transparency and engineering governance.

## Functional Architecture Matrix (Out-of-Band Dynamic HMAC + Isolated Clearing)
UTL demonstrates a strict separation between:
- **Signing / integrity markers** produced before the backend receives the transaction, and
- **Clearing / settlement routing** performed only inside isolated runtime environments that load configuration dynamically.

The payload signing flow is designed to operate independently from the clearing runtime:

### Textual Matrix

| Transaction Phase | Trust Anchor | Integrity Mechanism | Isolation Mechanism | Clearing Outcome |
|---|---|---|---|---|
| Mobile ingress verification | Mobile keychain-backed token | **Out-of-band dynamic HMAC hashes** attached as metadata | N/A (client-side) | Transaction proceeds only if local signing markers validate in the simulated gateway view |
| Gateway verification | Server-side verification ring | HMAC formatting and recomputation | Verification occurs in isolated runtime context | Gateway marks tenant-safe structure and forwards to clearing simulation |
| Tenant gateway isolation audit | Tenant boundary policy | Structural cryptographic isolation markers | Tenant-bound runtime separation | Prevents boundary crossing by design |
| Invariant environment routing assertions | Runtime configuration | Environment-derived routing token selection | Isolated clearing runtime | Settlement target is loaded from configuration (e.g., `process.env.SETTLEMENT_ACCOUNT`) and never hardcoded |
| Containerization non-root boundary scan | Runtime packaging | Compliance diagnostic report | Minimal runtime container | Build inputs discarded; immutable minimal runtime posture validated |

### Out-of-Band Signing and “Clearing Through Isolation”
UTL’s public simulation blueprint models a key design principle:

- **Signing occurs out-of-band** (from the mobile client) using dynamic HMAC verification.
- The **clearing step only executes** inside an isolated runtime that loads settlement routing variables from environment configuration rather than hardcoding values in source code.

This separation reduces attack surface, improves governance, and supports enterprise auditability.

## Secure Environment Design (No Sensitive Data)
This repository’s investor-facing demonstration design avoids storing sensitive data in source code.

### Dynamic Routing Variables from Localized Environment Values
UTL explicitly reads routing variables dynamically from localized environment variables.

For example:
- `process.env.SETTLEMENT_ACCOUNT` is treated as the active clearing target.
- The prototype simulator demonstrates that the clearing token is loaded from configuration rather than being hardcoded.

### Configuration Contract (Safe Mock Tokens)
To support local simulation and investor demonstration without exposing real credentials, the repository uses an `.env.example` configuration with safe mock tokens.

The evaluator can safely run the prototype simulator without any production values.

## `.env.example` Mapping Table
Use the following conceptual mapping to align runtime expectations. The prototype simulator is designed to load values from `.env` if present, otherwise it falls back to `.env.example`.

| File | Variable | Purpose | Recommended Example Value |
|---|---|---|---|
| `.env.example` | `MOCK_NCBA_LOOP_ACCOUNT_POOL` | Safe mock settlement target pool identifier | `MOCK_NCBA_LOOP_ACCOUNT_POOL__DEMO_8802_0000_0000_0000` |
| `.env.example` | `SETTLEMENT_ACCOUNT` | Active clearing target loaded at runtime | `880200283180` (mock-safe for simulation) |
| `.env.example` | `TENANT_ID` | Demonstrates tenant boundary isolation | `tenant_demo_a` |
| `.env.example` | `MOBILE_DEVICE_ID` | Simulated mobile keychain device identity | `device_demo_001` |
| `.env.example` | `HMAC_SIMULATION_SECRET` | Out-of-band HMAC simulation secret (mock-safe) | `MOCK_HMAC_SECRET__DEMO_ONLY` |

> Note: For the public demo workflow, the simulator uses safe tokens and emits structured validation markers on stdout.

## Interactive Quick Start Runbook
The following runbook enables an evaluator or team lead to initialize the local workspace, execute the interactive pipeline prototype simulator, and verify the platform locally.

### 1) Initialize your local environment
From the repository root:

```bash
# Ensure dependencies are not required for the stdout-only simulation.
# The simulator performs configuration parsing and cryptographic demonstration via local tooling.

# Optional: preview existing .env.example if present.
ls -la .env.example || true
```

### 2) Create or edit a local `.env` for simulation
Create a safe local `.env` file that overrides configuration at runtime.

```bash
cat << 'EOF' > .env
NODE_ENV=development
SETTLEMENT_ACCOUNT=880200283180
MOCK_NCBA_LOOP_ACCOUNT_POOL=MOCK_NCBA_LOOP_ACCOUNT_POOL__DEMO_8802_0000_0000_0000
TENANT_ID=tenant_demo_a
MOBILE_DEVICE_ID=device_demo_001
HMAC_SIMULATION_SECRET=MOCK_HMAC_SECRET__DEMO_ONLY
EOF
```

### 3) Execute the interactive prototype simulator

```bash
chmod +x scripts/run-prototype-simulation.sh
bash scripts/run-prototype-simulation.sh
```

### 4) Verify stage-by-stage results
The simulator prints four stage headers and PASS/FAIL markers including:
- **[SUCCESS] Stage [01]** mobile ingress HMAC simulation
- **[SUCCESS] Stage [02]** multi-tenant gateway isolation structural audit
- **[SUCCESS] Stage [03]** invariant environment routing assertions
- **[SUCCESS] Stage [04]** non-root container boundary scan compliance report

### 5) Post-run compliance capture (recommended)
Capture stdout for audit records:

```bash
bash scripts/run-prototype-simulation.sh | tee prototype-compliance-report.log
```

## Repository Deliverables
- `README.md` — Investor-ready architecture overview and runbook.
- `scripts/run-prototype-simulation.sh` — Interactive stdout simulator for the architectural workflow.
- `.github/workflows/verify-pipeline.yml` — GitHub Actions verification pipeline that tracks passing compliance metrics via GitHub Projects.

## Governance Notes
This blueprint is designed for public demonstration and investor evaluation. It provides repeatable, auditable output artifacts without requiring access to sensitive production infrastructure.

