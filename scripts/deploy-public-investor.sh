#!/usr/bin/env bash
set -euo pipefail

# deploy-public-investor.sh
# Safely push public investor artifacts to remote master using GH_TOKEN from the environment.
# Usage:
#   export GH_TOKEN="ghp_..."   # set in your session (do NOT hardcode)
#   ./scripts/deploy-public-investor.sh

if [ -z "${GH_TOKEN:-}" ]; then
  echo "Error: GH_TOKEN is not set. Export it first: export GH_TOKEN=\"<your-token>\"" >&2
  exit 1
fi

# ensure in repo root
if [ ! -d .git ]; then
  git init
fi

# ensure origin configured (without token)
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/jjaokoth/univer-escrow-core.git"

# fetch master shallowly if possible then ensure local master branch
git fetch origin master --depth=1 2>/dev/null || true
git checkout -B master

# Stage only the designated public manifest files
git add README.md src/types/PublicInterfaces.d.ts scripts/deploy-investor-manifest.sh SYSTEM_MODIFICATION_LOG.md

# Commit if there are staged changes
if git diff --cached --quiet; then
  echo "Nothing to commit (no staged changes)."
else
  git commit -m "docs: deploy public investor architecture prospectus and interface contracts"
fi

# Push securely using GH_TOKEN on the push URL without persisting it in config
git -c credential.helper= push "https://${GH_TOKEN}@github.com/jjaokoth/univer-escrow-core.git" master

# cleanup
unset GH_TOKEN

echo "Push complete."
