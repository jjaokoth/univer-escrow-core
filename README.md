# Univer Escrow — Investor Prospectus (Public README)

This repository publishes the public, investor-facing artifacts of the Univer Escrow Universal Trust Layer (UTL). It intentionally omits internal implementation details while providing auditors and investors with the artifacts needed to evaluate architecture, interfaces, and operational checks.

Purpose
- Provide a concise overview for investors and auditors.
- Explain what public artifacts are available and how to verify them.
- Point to the canonical investor checklist and validation steps.

Quick links
- Public typed contracts: `src/types/PublicInterfaces.d.ts`
- Public scripts / verification harness: `scripts/`
- Investor guide: `INVESTOR_GUIDE.md`

What this repo contains (public only)
- Architectural prospectus and guarantees (non-sensitive conceptual model)
- Typed interface contract artifacts for auditor consumption
- Public verification scripts for environment/telemetry checks
- A narrow set of deploy helpers used to publish only public artifacts

Investor summary
- System: Multi-tenant trust core designed to preserve tenant-scoped identity and deterministic state transitions.
- Guarantees: Tenant isolation, deterministic settlement gating, auditable token commitments for anonymized transactions.
- Risk highlights: public artifacts are deliberately limited; internal orchestration and secrets are not present here.

How to verify (short)
1. Review `INVESTOR_GUIDE.md` for step-by-step verification checklist.
2. Confirm the public interface types in `src/types/PublicInterfaces.d.ts` match the artifacts your audit expects.
3. Run the public verification scripts in `scripts/` in an isolated environment and compare outputs with the commit/PR history.

Security and provenance
- This repository exposes only public documentation and interface artifacts. No secrets or internal business logic should be present.
- Use the GitHub commit SHAs and PR history to confirm provenance of files. For release pushes, prefer short-lived tokens and CI-based deployments.

Recommended next steps for investors
- Read `INVESTOR_GUIDE.md` for a compact audit checklist and verification commands.
- Request the audit sandbox or ephemeral environment from the maintainers if you require deeper runtime verification.

Contact & legal
- For investor access, contact the maintainers listed in the repository metadata or open an issue asking for auditor access.

License
- See the repository `LICENSE` file.

---

For detailed, step-by-step procedures and checklist, see [INVESTOR_GUIDE.md](INVESTOR_GUIDE.md).


