#!/usr/bin/env bash
set -euo pipefail

# Safe Git Upstream Separation Script (Public Showcase)
# ------------------------------------------------------
# Goal:
# Prevent accidental leakage of proprietary Vault execution modules to a public Git
# remote ("Showcase"). This script constructs a dedicated local branch named
# public-showcase, strips private folders/files from that branch, and force-pushes
# it to the configured public remote.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REMOTE_SHOWCASE="${REMOTE_SHOWCASE:-public-showcase}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-public-showcase}"

# --------- Safety Stops ---------
stop_if_dirty() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "[FATAL] Working tree is dirty. Commit/stash before publishing." >&2
    exit 1
  fi
}

ensure_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[FATAL] Not a git repository." >&2
    exit 1
  fi
}

# --------- Branch Construction ---------
ensure_detached_public_branch() {
  # Always operate from a deterministic local branch.
  # - If it exists, reset it to HEAD.
  # - Otherwise create it.
  if git show-ref --verify --quiet "refs/heads/$PUBLIC_BRANCH"; then
    git branch -f "$PUBLIC_BRANCH" HEAD >/dev/null
  else
    git branch "$PUBLIC_BRANCH" HEAD >/dev/null
  fi

  # Detach by checking out the branch explicitly and then proceeding.
  git checkout "$PUBLIC_BRANCH" >/dev/null
}

# --------- Leakage Shielding ---------
remove_private_assets() {
  # 1) Remove root proprietary execution folders.
  rm -rf "src/middleware" "src/adapters" 2>/dev/null || true

  # 2) Remove environment files.
  rm -f ".env" ".env.*" 2>/dev/null || true

  # 3) Remove any provider private execution modules if present.
  rm -rf "securerise/packages/backend/src/middleware" 2>/dev/null || true
  rm -rf "securerise/packages/backend/src/adapters" 2>/dev/null || true
}

verify_no_private_leak() {
  # Search for forbidden paths using the tracked index/files list.
  local hits

  # Forbidden patterns:
  # - src/middleware/**
  # - src/adapters/**
  # - any .env or .env.* file
  hits=$(git ls-files | grep -E '(^src/(middleware|adapters)/|(^|/)\.env($|\.))' || true)

  if [[ -n "$hits" ]]; then
    echo "[FATAL] Private assets detected in public branch index/files:" >&2
    echo "$hits" >&2
    exit 1
  fi
}

# --------- Publish Flow ---------
main() {
  ensure_git_repo
  stop_if_dirty

  echo "[INFO] Current git remotes:";
  git remote -v || true

  ensure_detached_public_branch

  echo "[INFO] Stripping proprietary execution folders and env files..."
  remove_private_assets

  # Stage removals and commit only if necessary.
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "chore: publish-safe showcase (strip private vault modules)" >/dev/null
  fi

  verify_no_private_leak

  echo "[INFO] Pushing to remote '$REMOTE_SHOWCASE' branch '$PUBLIC_BRANCH' (force)..."
  git push --force --set-upstream "$REMOTE_SHOWCASE" "$PUBLIC_BRANCH"

  echo "[OK] Showcase publish completed safely."
}

main "$@"

