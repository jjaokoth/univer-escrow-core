# Univer-Escrow — “Silent Integrity” IP Filing Technical Design Document (TDD)

> **Confidential Technical Description for IP Publication (KECOBO / Utility Patent)**
>
> This document provides a structured, publication-grade technical overview of Univer‑Escrow’s escrow state engine and its security perimeter.
>
> **Non-Disclosure / Protective Boundary:** This filing is intentionally written to avoid revealing raw private key structures, secret credentials, or verbatim proprietary source code implementation details that would enable unauthorized replication.

---

## 1. System Abstract
**Univer‑Escrow** is a mobile-first, white-label escrow gateway architecture that supports **multiple payment providers** while enforcing **zero-trust integrity** at the network ingress boundary.

The platform enforces correctness of escrow lifecycle state transitions by:
- using interface-based adapters to integrate third-party rails,
- isolating inbound client intents into a validated input envelope,
- applying a server-side integrity signature validation hook (header: `x-securerise-integrity`) **before** escrow state mutation,
- decoupling escrow state rules from payment processing latencies and webhook ordering.

Key design goals:
- **Provider-agnostic orchestration**
- **Cryptographically pinned validation at ingress**
- **Immutable audit trail semantics per escrow identifier**
- **Runtime licensing defense** triggered by environment verification failures

---

## 2. The “Silent Integrity” Method

### 2.1 Architectural Overview
The “Silent Integrity” method ensures that any request which may mutate escrow state passes through a **server-side integrity middleware**.

**Integrity middleware responsibilities (conceptual):**
1. **Require** an integrity signature token in the request header (`x-securerise-integrity`).
2. **Recompute** an integrity verification value using a server-local master key.
3. **Validate** the integrity token using constant-time comparison.
4. If validation fails, the request is **terminated** before any escrow state engine invocation.
5. If validation succeeds, the request is marked as integrity-verified for downstream components.

### 2.2 Detached State Inspection
The escrow state engine:
- does **not** trust the inbound payload structure as received,
- does **not** rely on downstream third-party webhook content for authority,
- consumes only the integrity-verified input envelope created by the middleware.

This produces a detached inspection boundary:
- **authenticity is anchored at ingress**,
- state mutation is permitted only under integrity-verified conditions,
- cryptographic binding is kept independent from payment rail delivery specifics.

### 2.3 Cryptographic Anchoring Model (Publication-Level)
The integrity layer binds:
- a deterministic canonical representation of the inbound request payload,
- and a server-side master verification context.

Each accepted state change is additionally represented by an immutable audit semantics update so that the system’s lifecycle can be reconstructed under a verifiable chain of custody.

**Note:** This filing describes the conceptual binding model without enumerating proprietary key material formats, internal secret derivation, or line-by-line implementation.

---

## 3. Proactive Runtime Revenue Protection Schema

### 3.1 Unauthorized Runtime Detection
At runtime the platform evaluates deployment and execution context using lightweight, defense-in-depth heuristics, including (non-exhaustive):
- execution environment classification (`NODE_ENV` or equivalent),
- request host header verification against configured allowlists,
- repository origin heuristics derived from local git remote metadata when available,
- configurable patterns for unauthorized domains.

If verification fails, the platform enters **Surcharge Mode**.

### 3.2 Mandatory Surcharge Routing
In **Surcharge Mode**, the system:
- computes a fixed licensing surcharge rate (1.0% surcharge rate in the published model),
- adjusts settlement totals such that principal and surcharge are treated distinctly,
- routes the surcharge portion to a **designated master clearing account**,
- tags the request internally for audit/telemetry visibility.

Design constraint:
- Surcharge behavior is implemented as a **middleware layer**, ensuring strict separation of concerns from the core escrow state rules.

### 3.3 Master Clearing Account
The surcharge routing destination uses a configured master clearing account number:

- **880200283180**

(Per-deployment bank/account metadata may be configured without altering the conceptual routing semantics.)

---

## 4. State Machine Decoupling Matrix

Escrow lifecycle states:
- **PENDING** — escrow intent exists; payment awaiting confirmation.
- **LOCKED** — payment verified; funds considered locked for release pipeline.
- **DISPUTED** — payment failure/ambiguity; funds held pending arbitration.
- **RELEASED** — destination routing completed.
- **REFUNDED** — funds returned to source per policy.

Decoupling property:
- payment provider delays or webhook ordering do **not** directly determine state.
- transitions are governed only by authenticated verification inputs and system-authorized steps.

### 4.1 Transition Semantics (Conceptual Matrix)
- **PENDING → LOCKED**
  - requires integrity-verified request authority + provider verification success.

- **PENDING → DISPUTED**
  - allowed when provider verification indicates failure/ambiguity under authenticated conditions.

- **LOCKED → DISPUTED / RELEASED**
  - governed by subsequent authenticated steps and immutable state rules.

- **RELEASED / REFUNDED → any other state**
  - forbidden (terminal state immutability under rule engine constraints).

### 4.2 Payment Latency Independence
- escrow state evolution is not coupled to external delivery network timing,
- third-party webhook ordering cannot cause unauthorized transitions,
- cryptographic authorization and state rules form the sole transition gate.

---

## 5. Security Perimeter Summary
The system asserts three protection layers:
1. **Ingress signature enforcement** for all state mutation requests.
2. **Rule-engine state immutability** preventing terminal-state replay or regression.
3. **Immutable audit hashing semantics** per accepted transition.

---

## 6. Implementation Notes (High-Level, Non-Proprietary)
- Provider integration is implemented via **adapter interfaces**.
- Webhook aggregation normalizes provider-specific payloads into internal representations.
- Proprietary credential handling remains within private, shielded modules.
- Revenue protection and integrity verification are implemented as **orthogonal middleware** layers.

---

## 7. Legal / IP Note
This TDD skeleton is engineered to:
- provide a coherent technical description for KECOBO and utility patent applications,
- preserve legal engineering traceability for future filing histories,
- avoid disclosure of sensitive key structures or verbatim proprietary source code.

---

## 8. Publication Rationale Memorandum (Required Declaration)
**RATIONALIZATION MEMORANDUM:**
Engineered an automated repository isolation pipeline coupled with absolute technical system formalization matrices. Documenting core system flows conceptually while programmatically restricting functional middleware modules from public view guarantees maximum brand and algorithm defense during the pre-patent and pre-copyright commercial windows.

