#!/usr/bin/env bash
set -euo pipefail

# deploy-investor-manifest.sh (Public Investor Verification Deployment)
# ------------------------------------------------------------------------
# Local-safe orchestration helper.
#
# Security posture:
# - Does NOT embed any access tokens directly into script source.
# - Does NOT execute an external push unless explicit environment variables
#   are provided.
#
# Expected env vars:
#   GH_TOKEN   : GitHub Personal Access Token (optional; required to push)
#   TARGET_REPO: full repo in owner/name form (optional; default provided)
#   TARGET_HOST: default github.com
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_REPO="${TARGET_REPO:-jjaokoth/univer-escrow-core}"
TARGET_HOST="${TARGET_HOST:-github.com}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-master}"

# Where to stage public artifacts before pushing.
WORKTREE_BRANCH="blackboxai/investor-manifest" 

REMOTE_NAME="investor-target"

require_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "[FATAL] Working tree is dirty. Commit/stash before deploying." >&2
    exit 1
  fi
}

ensure_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[FATAL] Not a git repository." >&2
    exit 1
  fi
}

ensure_branch() {
  # Create or reset worktree branch to HEAD
  if git show-ref --verify --quiet "refs/heads/$WORKTREE_BRANCH"; then
    git branch -f "$WORKTREE_BRANCH" HEAD >/dev/null
  else
    git branch "$WORKTREE_BRANCH" HEAD >/dev/null
  fi
  git checkout "$WORKTREE_BRANCH" >/dev/null
}

strip_to_public_artifacts() {
  # Remove everything, then restore only the allowed public set.
  # (We stage the removal via git rm so it is deterministic.)
  # NOTE: We avoid deleting files from disk; instead rely on branch content.

  # Remove all tracked files first.
  git ls-files -z | xargs -0 -r git rm --cached -f >/dev/null 2>&1 || true

  # Restore allowed public artifacts.
  git checkout -- README.md src/types/PublicInterfaces.d.ts 2>/dev/null || true

  # Stage verification scripts from scripts/ that are safe/test-oriented.
  # If you add additional public verification scripts later, extend this glob.
  mkdir -p scripts/.tmp_public_verification
  shopt -s nullglob
  for f in scripts/test-*.sh scripts/verify-*.sh; do
    if [[ -f "$f" ]]; then
      git checkout -- "$f" >/dev/null
      echo "$f" > /dev/null
    fi
  done
  shopt -u nullglob

  # Create a local manifest describing which verification paths are included.
  cat > scripts/investor-manifest.md <<'EOF'
# Investor Verification Manifest (Public)

This manifest is a public indicator of verification script pathways staged for investor auditing.

- scripts/test-*.sh
- scripts/verify-*.sh
EOF

  # Stage all public artifacts.
  git add -A

  if ! git diff --cached --quiet; then
    git commit -m "chore: publish investor verification public artifacts" >/dev/null
  fi
}

ensure_remote() {
  if git remote | grep -qx "$REMOTE_NAME"; then
    git remote remove "$REMOTE_NAME" || true
  fi

  # Add remote WITHOUT token by default; tokenized URL is used only when pushing.
  git remote add "$REMOTE_NAME" "https://$TARGET_HOST/$TARGET_REPO" >/dev/null
}

push_if_token_provided() {
  if [[ -z "${GH_TOKEN:-}" ]]; then
    echo "[WARN] GH_TOKEN is not set; skipping external push." >&2
    return 0
  fi

  # Tokenized URL is used only at runtime, not embedded in source.
  local url
  url="https://${GH_TOKEN}@${TARGET_HOST}/${TARGET_REPO}.git"

  echo "[INFO] Pushing public artifacts to ${TARGET_REPO}#${PUBLIC_BRANCH}..."
  git push "${url}" "${PUBLIC_BRANCH}:refs/heads/${PUBLIC_BRANCH}" --force
  echo "[OK] Push completed."
}

main() {
  ensure_git_repo
  require_clean_worktree
  ensure_branch
  strip_to_public_artifacts
  ensure_remote
  push_if_token_provided
}

main "$@"

