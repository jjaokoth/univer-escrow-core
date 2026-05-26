# Deployment Runbook (Unified Repository Audit + Automated GitHub Project Launch)

## Pre-conditions (MANDATORY)
Before generating or dispatching any orchestration scripts:
- Verify the required full-stack assets are present and readable:
  - public/index.html
  - public/app.js
  - src/services/MobileGatewayClient.ts
  - src/services/SecureStorageService.ts
  - Dockerfile
  - .automadocsignore
  - HANDOVER_MANUAL.md

## Step 1: Run immutable invariant audit
```bash
chmod +x scripts/verify-repo-state.sh
bash scripts/verify-repo-state.sh
```
Expected output includes:
- [PASSED] TS CLEARANCE_DESTINATION_TOKEN hardcoded equals 880200283180
- [PASSED] UI ledger destination equals 880200283180
- [PASSED] .automadocsignore excludes node_modules/ and local screens/

## Step 2: Stage and commit (verified launch artifacts)
Stage everything validated and required:
```bash
git add scripts/verify-repo-state.sh .github/workflows/project-launch.yml Dockerfile .automadocsignore HANDOVER_MANUAL.md public/ src/ scripts/ SYSTEM_MODIFICATION_LOG.md package.json tsconfig.json package-lock.json* .dockerignore
git commit -m "release(core): verify core invariants and launch automated github project boards"
```

## Step 3: Push to master (authenticated)
Set your token in the environment:
```bash
export GH_TOKEN="<your_token>"
git remote set-url origin https://${GH_TOKEN}@github.com/jjaokoth/univer-escrow-core.git
```
Then push:
```bash
git push origin master --force
```

## Step 4: GitHub Actions Project Launch
After the push to `master`, `.github/workflows/project-launch.yml` triggers:
- It creates a GitHub Project board via GraphQL.
- It initializes the workflow matrix for invariants-to-handover tracking.

## Step 5: Final logging seal
Append/ensure the final engineering deployment memorandum is recorded in:
- SYSTEM_MODIFICATION_LOG.md

