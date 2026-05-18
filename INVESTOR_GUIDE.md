# Investor Guide — Univer Escrow (UTL)

This guide provides the minimal, practical steps an investor or auditor should follow to validate the publicly-published artifacts for Univer Escrow.

1) Scope
- This guide covers only public artifacts in this repository: documentation, typed interfaces, and public verification scripts.
- It does NOT cover internal orchestration code, secrets, or private CI pipelines.

2) Files of interest
- `README.md` — investor summary and quick links
- `INVESTOR_GUIDE.md` — this file (checklist + commands)
- `src/types/PublicInterfaces.d.ts` — typed, public contract surfaces
- `scripts/` — public verification and test harness scripts
- `SYSTEM_MODIFICATION_LOG.md` — public changelog surface (may be empty)

3) Quick verification checklist (local)
- Clone or fetch only this repository's public files (or review on GitHub web UI).
- Confirm current commit: `git log -1 --pretty=oneline` (verify SHA against the maintainer-provided SHA).
- Inspect the typed contracts: open `src/types/PublicInterfaces.d.ts` and validate the exported signatures.
- Run the verification scripts in an isolated container (do not run on production machines):

```bash
# run in a disposable container or ephemeral VM
git clone https://github.com/jjaokoth/univer-escrow-core.git --depth=1
cd univer-escrow-core
bash scripts/verify-local-mesh.sh || true
bash scripts/test-telemetry-pipeline.sh || true
```

4) Validate provenance & commit history (web/UI)
- Confirm the commit SHA for each public file matches the SHA the maintainer provides.
- Confirm PRs/branches: prefer reviewing a PR that introduces any public-file change.

5) Validate interface contracts
- Use TypeScript tooling to type-check the `src/types` contract surface:

```bash
npm ci    # or install dev deps in a disposable env
npx tsc --noEmit --skipLibCheck
```

6) Minimal legal & compliance checks
- Confirm the repository lists a license and maintainer contacts.
- Confirm the `SYSTEM_MODIFICATION_LOG.md` is present and asks for publicly visible change notes.

7) Operational notes for deeper audits
- Request an ephemeral demo environment or sanitized dataset from maintainers for runtime tests.
- Ask for HSM or secrets handling policy if cryptographic sealing is part of the audit scope.

8) Contact & next steps
- Open an issue or contact the maintainers for additional artifacts, CI logs, or sandbox access.

Appendix: example commands to verify a single file's SHA on GitHub (web API)

```bash
GH_OWNER=jjaokoth
GH_REPO=univer-escrow-core
FILE_PATH=src/types/PublicInterfaces.d.ts
curl -s "https://api.github.com/repos/$GH_OWNER/$GH_REPO/commits?path=$FILE_PATH" | jq '.[0].sha'
```

If you want, I can:
- run the suggested local checks in a disposable environment here and report results,
- or create a PR with any additional investor-facing clarifications you want added.
