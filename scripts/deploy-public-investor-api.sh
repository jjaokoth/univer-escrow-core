#!/usr/bin/env bash
set -euo pipefail

# deploy-public-investor-api.sh
# Create a single commit on the remote `master` updating only the listed public files
# Uses GitHub Git Data API; requires `GH_TOKEN` exported in the environment with repo scope.

OWNER="jjaokoth"
REPO="univer-escrow-core"
BRANCH="master"
MSG="docs: deploy public investor architecture prospectus and interface contracts"

FILES=(
  "README.md"
  "src/types/PublicInterfaces.d.ts"
  "scripts/deploy-investor-manifest.sh"
  "SYSTEM_MODIFICATION_LOG.md"
  "scripts/deploy-public-investor.sh"
)

if [ -z "${GH_TOKEN:-}" ]; then
  echo "Error: GH_TOKEN is not set. Export it before running." >&2
  exit 1
fi

API="https://api.github.com/repos/$OWNER/$REPO"
HDR=( -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github.v3+json" )

# helper not needed; use small python one-liners for JSON extraction

echo "Fetching remote master reference..."
ref_json=$(curl -sS "${HDR[@]}" "$API/git/refs/heads/$BRANCH")
commit_sha=$(printf '%s' "$ref_json" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('object',{}).get('sha',''))")
if [ -z "$commit_sha" ]; then
  echo "Failed to get remote head for $BRANCH" >&2
  echo "$ref_json" >&2
  exit 1
fi

commit_json=$(curl -sS "${HDR[@]}" "$API/git/commits/$commit_sha")
base_tree=$(printf '%s' "$commit_json" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('tree',{}).get('sha',''))")
if [ -z "$base_tree" ]; then
  echo "Failed to read base tree from commit: $commit_sha" >&2
  echo "$commit_json" >&2
  exit 1
fi

declare -a tree_entries

for path in "${FILES[@]}"; do
  if [ -f "$path" ]; then
    echo "Preparing $path"
    # base64 encode content (no line wraps)
    content_b64=$(base64 -w0 "$path")
    blob_json=$(curl -sS "${HDR[@]}" -X POST "$API/git/blobs" -d "{\"content\":\"$content_b64\",\"encoding\":\"base64\"}")
    blob_sha=$(printf '%s' "$blob_json" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('sha',''))")
    if [ -z "$blob_sha" ]; then
      echo "Failed creating blob for $path" >&2
      echo "$blob_json" >&2
      exit 1
    fi
    tree_entries+=("{\"path\":\"$path\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$blob_sha\"}")
  else
    echo "Warning: local file $path not found; it will be created empty on remote." >&2
    # create empty blob
    blob_json=$(curl -sS "${HDR[@]}" -X POST "$API/git/blobs" -d '{"content":"","encoding":"utf-8"}')
    blob_sha=$(printf '%s' "$blob_json" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('sha',''))")
    tree_entries+=("{\"path\":\"$path\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$blob_sha\"}")
  fi
done

# assemble tree payload (join entries with commas)
IFS=,
tree_items=$(printf "%s" "${tree_entries[*]}")
unset IFS
tree_payload="{\"base_tree\":\"$base_tree\",\"tree\":[$tree_items]}"
echo "Creating new tree..."
new_tree_json=$(curl -sS "${HDR[@]}" -X POST "$API/git/trees" -d "$tree_payload")
new_tree_sha=$(printf '%s' "$new_tree_json" | python3 -c "import sys,json
try:
  j=json.load(sys.stdin)
  print(j.get('sha',''))
except:
  sys.exit(0)
")
if [ -z "$new_tree_sha" ]; then
  new_tree_sha=$(printf '%s' "$new_tree_json" | grep -m1 '"sha"' | sed -E 's/.*"sha":\s*"([^\"]+)".*/\1/') || true
fi
if [ -z "$new_tree_sha" ]; then
  echo "Failed creating tree; response:" >&2
  echo "$new_tree_json" >&2
  exit 1
fi

echo "Creating commit..."
commit_payload=$(printf '{"message":"%s","tree":"%s","parents":["%s"]}' "$MSG" "$new_tree_sha" "$commit_sha")
new_commit_json=$(curl -sS "${HDR[@]}" -X POST "$API/git/commits" -d "$commit_payload")
new_commit_sha=$(printf '%s' "$new_commit_json" | python3 -c "import sys,json
try:
  j=json.load(sys.stdin)
  print(j.get('sha',''))
except:
  sys.exit(0)
")
if [ -z "$new_commit_sha" ]; then
  new_commit_sha=$(printf '%s' "$new_commit_json" | grep -m1 '"sha"' | sed -E 's/.*"sha":\s*"([^\"]+)".*/\1/') || true
fi
if [ -z "$new_commit_sha" ]; then
  echo "Failed creating commit; response:" >&2
  echo "$new_commit_json" >&2
  exit 1
fi

echo "Updating $BRANCH reference to new commit..."
update_json=$(curl -sS "${HDR[@]}" -X PATCH "$API/git/refs/heads/$BRANCH" -d "{\"sha\":\"$new_commit_sha\"}")
if echo "$update_json" | grep -qi "error\|warning\|message"; then
  echo "Remote update response:" >&2
  echo "$update_json" >&2
fi

echo "Done. Created commit $new_commit_sha and updated $BRANCH." 
