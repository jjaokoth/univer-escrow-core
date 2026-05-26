#!/usr/bin/env bash
set -euo pipefail

TARGET_ACCOUNT="880200283180"
REPO_OWNER="jjaokoth"
REPO_NAME="univer-escrow-core"

if [[ "${1:-}" != "" ]]; then
  echo "[final-hub-crosscheck] Usage: bash scripts/final-hub-crosscheck.sh" >&2
  exit 2
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "[final-hub-crosscheck] ERROR: GH_TOKEN environment variable is not set." >&2
  exit 1
fi

api_get() {
  local url="$1"
  curl -sS \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${url}"
}

raw_file() {
  local path="$1"
  local url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=master"

  api_get "$url" | node -e "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j && j.encoding==='base64' && j.content){const b=Buffer.from(j.content.replace(/\\n/g,''),'base64').toString('utf8');process.stdout.write(b);} else {process.exit(1);} }catch(e){process.exit(1);}})"
}

check_remote_readable() {
  local label="$1"; shift
  local path="$1"; shift

  local content
  content="$(raw_file "$path")"

  if [[ -n "$content" ]]; then
    echo "[SUCCESS] ${label} is live and readable: ${path}"
  else
    echo "[ERROR] ${label} is empty or unreadable: ${path}" >&2
    exit 1
  fi
}

require_remote_string() {
  local label="$1"; shift
  local path="$1"; shift
  local needle="$1"; shift

  local content
  content="$(raw_file "$path")"

  if printf '%s' "$content" | grep -F -q -- "$needle"; then
    echo "[SUCCESS] ${label} contains frozen invariant account ${TARGET_ACCOUNT}"
  else
    echo "[ERROR] ${label} does not contain frozen invariant account ${TARGET_ACCOUNT}" >&2
    exit 1
  fi
}

graphql_request() {
  local query="$1"
  local variables_json="$2"

  curl -sS \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    --data-urlencode "query=${query}" \
    --data-urlencode "variables=${variables_json}" \
    "https://api.github.com/graphql"
}

main() {
  echo "[final-hub-crosscheck] Starting remote inventory cross-check and hub alignment verification..."

  check_remote_readable "public/index.html" "public/index.html"
  check_remote_readable "public/app.js" "public/app.js"
  check_remote_readable "src/services/MobileGatewayClient.ts" "src/services/MobileGatewayClient.ts"

  check_remote_readable "Dockerfile" "Dockerfile"
  check_remote_readable ".dockerignore" ".dockerignore"
  check_remote_readable ".automadocsignore" ".automadocsignore"

  check_remote_readable "README.md" "README.md"
  check_remote_readable "HANDOVER_MANUAL.md" "HANDOVER_MANUAL.md"
  check_remote_readable "SYSTEM_MODIFICATION_LOG.md" "SYSTEM_MODIFICATION_LOG.md"

  require_remote_string "public/index.html UI ledger destination" "public/index.html" "$TARGET_ACCOUNT"
  require_remote_string "src/services/MobileGatewayClient.ts clearance destination token" "src/services/MobileGatewayClient.ts" "$TARGET_ACCOUNT"

  echo "[final-hub-crosscheck] Verifying GitHub Projects v2 board: Universal Trust Layer Core Management Board"

  local find_query
  find_query='query($owner:String!, $title:String!) { repository(owner:$owner, name:"univer-escrow-core") { projectsV2(first: 50, orderBy:{field:CREATED_AT, direction:DESC}) { nodes { id title } } } }'

  local find_result
  find_result="$(graphql_request "$find_query" '{"owner":"jjaokoth","title":"Universal Trust Layer Core Management Board"}')"

  local board_id
  board_id="$(printf '%s' "$find_result" | node -e "const s=require('fs').readFileSync(0,'utf8');const j=JSON.parse(s);const nodes=j?.data?.repository?.projectsV2?.nodes||[];const match=nodes.find(n=>n && n.title==='Universal Trust Layer Core Management Board');if(!match){process.exit(2);}process.stdout.write(match.id);")"

  echo "[SUCCESS] Projects v2 board located: Universal Trust Layer Core Management Board (id=${board_id})"

  local cols_query
  cols_query='query($projectId:ID!) { node(id:$projectId) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }'

  local cols_result
  cols_result="$(graphql_request "$cols_query" "{\"projectId\":\"${board_id}\"}")"

  local wanted
  wanted='Invariants Audited|Multi-Tenant Isolation Verified|Container Release Ready|Handover Completed'

  local missing
  missing="$(printf '%s' "$cols_result" | node -e "const s=require('fs').readFileSync(0,'utf8');const j=JSON.parse(s);const nodes=j?.data?.node?.fields?.nodes||[];let optNames=[];for(const f of nodes){ if(f && f.options){ for(const o of f.options){ if(o && o.name) optNames.push(o.name); } } } const wanted=['Invariants Audited','Multi-Tenant Isolation Verified','Container Release Ready','Handover Completed']; const set=new Set(optNames); const missing=wanted.filter(w=>!set.has(w)); if(missing.length){console.log(missing.join(','));} else {console.log('');}")"

  if [[ -n "$missing" ]]; then
    echo "[ERROR] Missing project columns: ${missing}" >&2
    exit 3
  fi

  echo "[SUCCESS] GitHub Projects columns present: ${wanted//|/, }"
  echo "[final-hub-crosscheck] COMPLETED: remote inventory, invariant strings, and Projects v2 Kanban columns aligned."
}

main "$@"

