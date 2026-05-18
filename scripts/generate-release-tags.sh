#!/usr/bin/env bash
set -euo pipefail

# generate-release-tags.sh
# Self-contained release tag helper.
#
# Expected usage:
#   scripts/generate-release-tags.sh <oldVersion> <newVersion> [--dry-run]
#
# Notes:
# - This repository uses SemVer tags (e.g., v1.0.0).
# - If --dry-run is provided, no tag is created.

OLD_VERSION="${1:-}"
NEW_VERSION="${2:-}"
DRY_RUN="${3:-}"

if [[ -z "$OLD_VERSION" || -z "$NEW_VERSION" ]]; then
  echo "Usage: $0 <oldVersion> <newVersion> [--dry-run]" >&2
  exit 1
fi

if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
  echo "No version change detected. Exiting." >&2
  exit 0
fi

if [[ ! "$NEW_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "NEW_VERSION must be semver like v1.0.1" >&2
  exit 1
fi

# Normalize to vX.Y.Z
if [[ "$NEW_VERSION" != v* ]]; then
  NEW_VERSION="v${NEW_VERSION}"
fi

# Collect commit messages since OLD_VERSION
# If OLD_VERSION tag doesn't exist, include entire history.
CHANGELOG_FILE="CHANGELOG_${NEW_VERSION}.md"

if git rev-parse -q --verify "refs/tags/${OLD_VERSION}" >/dev/null 2>&1; then
  RANGE="${OLD_VERSION}..HEAD"
else
  RANGE="HEAD"
fi

{
  echo "# Release ${NEW_VERSION}"
  echo
  echo "## Changes"
  echo
  git log --pretty=format:"- %s" --no-merges ${RANGE}
} > "$CHANGELOG_FILE"

echo "Generated ${CHANGELOG_FILE}"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "Dry run enabled. Tag not created." >&2
  exit 0
fi

# Create annotated tag
# Note: cryptographic signing depends on local git configuration.
# If signing is configured, GPG will be used automatically.
# Fallback to unsigned tag if signing fails.

if git tag -a "${NEW_VERSION}" -F "$CHANGELOG_FILE"; then
  echo "Tag created: ${NEW_VERSION}"
else
  echo "Tag creation failed" >&2
  exit 1
fi

# Push tags if remote is configured
if git remote | grep -q .; then
  git push --tags || true
fi

