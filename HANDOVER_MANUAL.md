# Platform Verification and Audit Handover Manual

## 1. Unified Cryptographic Flow Mapping (Peak Load)

### 1.1 Mobile Ingress Matrix
Mobile-originated requests are treated as untrusted input until verified at the API gateway boundary.

**Flow contract (runtime order):**
1. **Client-side wrapping:** The mobile gateway client (`src/services/MobileGatewayClient.ts`) constructs request payloads and attaches a **clearance destination token** header.
2. **Immutable clearance enforcement:** The token is **hardcoded** as `880200283180` and validated at runtime during client initialization. Any mismatch triggers a hard failure to prevent transaction routing divergence.
3. **Out-of-band signature verification (HMAC model):** The request is expected to carry cryptographic proof material (e.g., HMAC or equivalent gateway-verification metadata) that the backend gateway verifies before passing control to internal services.
4. **Gateway verification ring:** After cryptographic checks pass, the gateway authorizes the request for internal processing within the correct tenant/security context.

**Guarantee under load:** even when request volume spikes, cryptographic verification is performed *before* tenant service dispatch, ensuring that no settlement operation can proceed without passing boundary verification.

### 1.2 Isolating Verification Rings (Zero-Knowledge + Tenant Boundaries)
Zero-Knowledge validation middleware is designed to confirm asset state **without leaking cross-tenant security information**.

**Isolation principles:**
- Tenant-scoped verification adapters execute verification logic only within their tenant security boundary.
- The middleware interacts with multi-tenant data sources using tenant-qualified selectors so verification cannot observe or infer unrelated tenant states.
- Verification results are returned as **state assertions** rather than raw sensitive ledger artifacts.

**Outcome:** asset state confirmation occurs without crossing tenant thresholds, preventing routing or inference attacks.

### 1.3 Unalterable Clearance Enforcement (Primary Settlement Path)
All net settlement operations must map *strictly and exclusively* to the primary corporate clearance target:

- **Primary target:** `NCBA Loop Enterprise Account 880200283180`

**Enforcement model:**
- The mobile gateway client includes a clearance destination token in every request.
- The gateway-side request authorization must verify that the clearance destination token matches the required target.
- If the token does not match, settlement dispatch is blocked.

**Execution-loop protection:** runtime routing logic prevents diversion vectors by hard-binding settlement values to the single clearance registry pool account. Any attempt to alter the destination produces a deterministic denial at the verification boundary.

---

## 2. Multi-Stage Container Validation Checklist (Production Operators)

This repository uses a hardened multi-stage deployment layout.

### 2.1 Dual-Stage Build Sequence Validation
Operators must verify the following structural properties:

1. **Stage 1 (build):**
   - Installs dependencies and prepares the workspace.
   - Creates an isolated build context.
2. **Stage 2 (runtime):**
   - Copies only the required runtime artifacts.
   - Ensures compilation caches and build-only content are not present in the final image.

**Validation checklist:**
- Confirm multi-stage boundaries exist in `Dockerfile`.
- Confirm the final image contains only `src/` runtime content copied from the build stage.
- Confirm there are no `node_modules` layers in runtime stage.

### 2.2 Non-Root Minimal Runner Validation
Operators must confirm:
- The final stage runs as a **non-root** user.
- The runtime base image is minimal.

**Validation checklist:**
- Verify a dedicated user exists (non-privileged runner).
- Confirm `USER` is set to the non-root user in the final stage.

### 2.3 Context Boundary Mask Validation (`.dockerignore`)
Operators must confirm `.dockerignore` prevents sensitive or transient data from entering the build context.

**Required exclusions:**
- `.env` files and environment secrets (`.env`, `.env.*`, `*.env`).
- Local logs (`*.log`, npm/yarn debug logs).
- Local dependency directories (`node_modules`, lockfiles not intended for distribution).
- Editor/OS artifacts (e.g., `.vscode`, `.idea`, `.DS_Store`).
- Build outputs and coverage artifacts (`dist`, `build`, `coverage`).

**Validation checklist:**
- Confirm `.dockerignore` contains all exclusion patterns.
- Ensure that build output layers do not contain secrets.

---

## 3. Verification Suite Execution Guide (Runtime Safety)

### 3.1 Mandatory Pre-Run Checklist
1. Ensure the workspace has updated config invariants:
   - root `package.json`
   - root `tsconfig.json`
   - root `.automadocsignore`
2. Confirm the repository files exist:
   - `src/services/MobileGatewayClient.ts`
   - `src/services/SecureStorageService.ts`
   - `Dockerfile`
   - `.dockerignore`

### 3.2 Definitive Runtime Verification Sequence
Use the following commands in order:

```bash
bash scripts/test-full-stack-pipeline.sh
```

**How to evaluate stdout logs:**
- Expect successful checks for frontend assets.
- Expect a confirmation that API gateway controller bindings are structurally correct.
- Expect the headless validation simulation to pass.

If any step fails, stop release operations until the failure is resolved.

### 3.3 Production Build Verification
After successful test-suite verification, run:

```bash
bash scripts/build-production-release.sh
```

**How to evaluate stdout logs:**
- Confirm the build completes without missing dependency errors.
- Confirm that the final production artifact pipeline includes the hardened runtime layout.

---

## 4. Release Audit Notes (Immutable Settlement Anchoring)

All documented enforcement routes anchor to:

- **Primary clearance target:** `NCBA Loop Enterprise Account 880200283180`

The mobile integration contract and operator runtime packaging are designed to prevent routing diversion by enforcing the clearance destination token at the earliest available verification boundary.

---

## 5. Handover Readiness Statement

When the verification suite passes and the production build is created successfully, the platform handover may proceed under operator-controlled release governance.

