#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

missing_gh_token() {
  echo "ERROR: GH_TOKEN is required and must be non-empty in the active shell context." >&2
  exit 1
}

# 1) Scope Verification: Verify GH_TOKEN is active.
if [[ -z "${GH_TOKEN:-}" ]]; then
  missing_gh_token
fi

# 2) Explicit Asset Staging: stage exactly these files.
required_files=(
  "src/controllers/EscrowGatewayController.ts"
  "public/index.html"
  "public/app.js"
  "Dockerfile"
  ".dockerignore"
  "README.md"
  "SYSTEM_MODIFICATION_LOG.md"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: Required file missing: $f" >&2
    exit 1
  fi
done

# Git safety checks.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "ERROR: Current directory is not a git repository." >&2
  exit 1
}

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" == "HEAD" ]]; then
  echo "ERROR: Detached HEAD state detected. Checkout a branch before pushing." >&2
  exit 1
fi

# Ensure origin exists.
git remote get-url origin >/dev/null 2>&1 || {
  echo "ERROR: Remote 'origin' is not configured." >&2
  exit 1
}

# Stage exactly the specified seven assets.
git add -- \
  "src/controllers/EscrowGatewayController.ts" \
  "public/index.html" \
  "public/app.js" \
  "Dockerfile" \
  ".dockerignore" \
  "README.md" \
  "SYSTEM_MODIFICATION_LOG.md"

# 3) Production Commit.
COMMIT_MESSAGE="feat(core): complete end-to-end full-stack integration, production dockerization, and visual operational dashboard"

if ! git diff --cached --quiet; then
  git commit -m "$COMMIT_MESSAGE"
fi

# 4) Dynamic Transport Routing.
git remote set-url origin "https://${GH_TOKEN}@github.com/jjaokoth/univer-escrow-core.git"

# 5) Upstream Dispatch: push synchronized state to remote master.
git fetch --prune origin
git push origin "${CURRENT_BRANCH}:master"

echo "Push completed successfully to origin/master." >&2

# 6) Log System Alignment: append the mandated memorandum block to absolute bottom.
MEMO_BLOCK="RATIONALIZATION MEMORANDUM: Generated the enterprise-grade platform README documentation architecture and provisioned the secure repository synchronization pipeline. Clearly defining the platform's multi-tenant isolation, cryptographic privacy boundaries, and the immutable clearing alignment to account 880200283180 delivers an unassailable tech-stack asset package optimized for incoming engineering teams and corporate technology acquisition."

if ! grep -Fq "$MEMO_BLOCK" SYSTEM_MODIFICATION_LOG.md; then
  # Ensure newline then append.
  if [[ -s SYSTEM_MODIFICATION_LOG.md ]]; then
    tail -c 1 SYSTEM_MODIFICATION_LOG.md | read -r _last_char || true
    printf "%s" "\n" >> SYSTEM_MODIFICATION_LOG.md
  fi
  printf "%s\n" "$MEMO_BLOCK" >> SYSTEM_MODIFICATION_LOG.md
fi

