# BRAINSTORM_PLAN — Cross-Enclave BFT State Transition Verification

## Goal
Upgrade the consensus loop so that no state transition is committed to disk unless an absolute Byzantine-majority quorum of **distinct, attested enclaves** independently validated the proposed log entry, computed the matching Merkle-leaf commitment hash, and produced a threshold-valid cryptographic approval payload.

## Files in scope
- `src/services/consensus/EnclaveBftVerifyEngine.ts`
- `src/services/consensus/EnclaveRaftEngine.ts`
- `src/services/EscrowRouter.ts`
- `src/tests/enclaveBftVerify.test.ts`

## Non-goals (for this iteration)
- Implement real cryptographic signature aggregation (this repo uses deterministic mock cryptography). Keep the API surface and aggregation semantics strict/fail-closed.

---

## Architecture blueprint (what to implement)

### 1) Verification Gate: follower-side independent enclave approval share
**Endpoint:** `POST /api/consensus/verify-state-transition`
- Input: `{ nodeId, nodePcr0Hash, proposal, consensusMetadata }`
- Router must:
  - Fail closed if enclave not ready.
  - Verify proposal structural integrity (ZK commitment fields + PQC hybrid signature fields + time-lock constraints).
  - Verify the commitment binding: `proposal.record.escrowRecordLeafHash` must equal `proposal.commitment`.
  - Verify time-lock constraints using a median time anchor that is cryptographically bound to the proposal (at minimum: compare fingerprint/anchorMs).
  - If valid, return `VerificationShare` that includes:
    - `nodeId`
    - `nodePcr0Hash` (identity binding)
    - `consensusTerm`, `index`
    - `approvalHash` deterministically bound to `(transactionId, commitment, consensusTerm, index, nodeId)`
    - `nodeSignature` computed as: `SHA256(transactionId || commitment || consensusTerm || nodeSecret)` with domain separation.

### 2) Threshold multi-signature aggregation (inside engine)
**Engine:** `EnclaveBftVerifyEngine.aggregateShares()`
- Inputs:
  - proposed log entry (`StateTransitionProposal`)
  - list of `VerificationShare`
  - mapping `nodeId -> expectedPcr0Hash` derived from attestation/cluster topology
- Behavior:
  - Reject shares if `consensusTerm` or `index` mismatch.
  - Reject shares whose `nodePcr0Hash` doesn’t match expected attestation-derived identity.
  - Count only distinct `nodeId`s.
  - Compute quorum threshold for cluster size N:
    - `f = floor((N-1)/3)`
    - `threshold = 2f + 1`
  - **Return a `ThresholdMultiSigPayload`** only if distinct shares >= threshold.

### 3) Commit execution: consume the validated threshold payload
**Engine:** `EnclaveRaftEngine.commitToLedgerIfBftQuorum()`
- Replace the current interface `signedValidationNodeIds: string[]` with a payload:
  - `payload: ThresholdMultiSigPayload`
- Commit is allowed **only if**:
  - `payload.threshold` reached
  - `payload.uniqueNodeIds.length >= payload.threshold`
  - `payload.shares` are consistent with the entry’s term/index/commitment.
- Fail closed: if payload invalid/missing/insufficient => do not call `DatabaseService.saveRecord`.

### 4) Cross-enclave router extensions
**Endpoint:** `/api/consensus/append-entry`
- Leader proposes and broadcasts the block.
- Followers must verify and respond via `/verify-state-transition`.
- Leader collects shares and only then invokes `/append-entry` with the **threshold payload**.
- Router must ensure that an attacker can’t trigger disk writes by submitting only node IDs; it must require the payload.

---

## Concrete edit plan (file-by-file)

### A) `src/services/consensus/EnclaveBftVerifyEngine.ts`
1. Strengthen `verifyProposalStructurally()` to explicitly reject:
   - missing `timeLocks.quorumMedianAnchor.anchorFingerprint`
   - mismatch/invalid `anchorMs` types
2. Add a method (or inline logic) to verify time-lock anchor fingerprint binding:
   - e.g. compute a deterministic fingerprint from `(anchorMs, includedNodeIds, outlierNodeIds)` and ensure it equals the proposal’s `anchorFingerprint`.
   - If mismatch => fail closed.
3. Make sure `approvalHash` includes `index` and `commitment` and `consensusTerm` (already included); keep exactly deterministic.
4. Ensure `aggregateShares()` returns payload with:
   - `shares` sorted and `uniqueNodeIds` derived from those shares.
5. Add helper `validateShareAgainstProposal(share, proposal)` (fail closed in aggregation).

### B) `src/services/consensus/EnclaveRaftEngine.ts`
1. Update signature of `commitToLedgerIfBftQuorum()`:
   - from `{ entryIndex, clusterSize, signedValidationNodeIds }`
   - to `{ entryIndex, clusterSize, proposalCommitment, consensusTerm, index, payload }`
   - or accept `payload` and extract commitment/term/index from `payload.shares[0]` plus validate.
2. Enforce:
   - `payload.threshold === 2f+1` computed from `clusterSize`
   - `payload.uniqueNodeIds.length >= payload.threshold`
   - `payload.shares` length >= payload.threshold
   - all `payload.shares[i]` match `consensusTerm` and `index`.
3. Commit must check `entry.record.escrowRecordLeafHash === proposalCommitment` before saving.

### C) `src/services/EscrowRouter.ts`
1. In `/consensus/verify-state-transition`, extend the handler to validate proposal time-lock fingerprint binding (using engine or inline check).
2. Add types for request payloads (compile-safe for Node16/CommonJS).
3. In `/consensus/append-entry`:
   - require `bft.payload` (or `bft.thresholdPayload`) in addition to `bft.clusterSize`
   - pass payload into `commitToLedgerIfBftQuorum()`
   - if payload missing/invalid => 409/403 and no disk commit.

### D) `src/tests/enclaveBftVerify.test.ts`
1. Rewrite regression to be end-to-end fails-closed:
   - Create two proposals: `proposalValid` and `proposalRogue`.
   - Generate honest shares for valid proposal.
   - Attempt to generate shares for rogue proposal.
   - Ensure aggregation and commit gate only allow the valid commitment.
2. Add a ledger persistence assertion:
   - before/after `DatabaseService.getAllRecords()` length must not change when rogue proposal is forced.
3. Also simulate that attacker tries to call `/append-entry` with only node IDs:
   - expected: route rejects without threshold payload.

---

## Verification commands
- `npx tsc -p tsconfig.json --noEmit`
- `npm test`
- If needed: `node ./src/tests/enclaveBftVerify.test.ts` equivalent (depending on test runner setup)

