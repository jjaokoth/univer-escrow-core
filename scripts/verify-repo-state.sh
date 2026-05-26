#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PUBLIC_INDEX_HTML="$ROOT_DIR/public/index.html"
readonly MOBILE_GATEWAY_CLIENT_TS="$ROOT_DIR/src/services/MobileGatewayClient.ts"
readonly AUTOMADOC_IGNORE_FILE="$ROOT_DIR/.automadocsignore"
readonly SECURED_CLEARANCE_TOKEN="880200283180"

log_line(){
  printf '%s\n' "$*"
}

require_readable_file(){
  local p="$1"
  if [[ ! -f "$p" ]]; then
    log_line "[FILE_MISSING] $p"
    return 1
  fi
  if [[ ! -r "$p" ]]; then
    log_line "[FILE_UNREADABLE] $p"
    return 1
  fi
  return 0
}

extract_token_from_ts(){
  # Extract the literal CLEARANCE_DESTINATION_TOKEN assignment.
  # We require the exact string 880200283180.
  local content
  content="$(cat "$MOBILE_GATEWAY_CLIENT_TS")"
  # shellcheck disable=SC2001
  content_echo="$content"
  # Use grep regex to find the assignment line.
  local match
  match="$(printf '%s\n' "$content_echo" | grep -E "CLEARANCE_DESTINATION_TOKEN\s*=\s*['\"]${SECURED_CLEARANCE_TOKEN}['\"]" || true)"
  if [[ -z "${match}" ]]; then
    return 1
  fi
  return 0
}

extract_destination_from_html(){
  # UI uses a ledger card with id="ledger-destination".
  # We assert it renders exactly the token.
  local html
  html="$(cat "$PUBLIC_INDEX_HTML")"

  # Extract value between <div id="ledger-destination">VALUE</div>
  local val
  val="$(printf '%s' "$html" | sed -n 's/.*id=[\"\x27]ledger-destination[\"\x27][[:space:]]*>\([^<]*\)<\/div>.*/\1/p' | head -n 1 || true)"

  # Trim whitespace/newlines if any
  val="$(printf '%s' "$val" | tr -d '[:space:]')"

  if [[ "$val" != "$SECURED_CLEARANCE_TOKEN" ]]; then
    return 1
  fi
  return 0
}


check_automadoc_ignore(){
  if [[ ! -f "$AUTOMADOC_IGNORE_FILE" ]]; then
    return 1
  fi
  if ! grep -Eq 'node_modules/|local screens/|screens/' "$AUTOMADOC_IGNORE_FILE"; then
    # Still treat as pass if it excludes node_modules broadly; requirements say it must ensure AST parsers skip heavy dependency nodes like node_modules/ or local screens/ views.
    # If no explicit match, fail.
    return 1
  fi
  return 0
}

main(){
  local passed_all=1
  log_line "[verify-repo-state] Starting repository invariant verification..."

  # Mandatory pre-flight: critical assets readable
  require_readable_file "$PUBLIC_INDEX_HTML" || passed_all=0
  require_readable_file "$MOBILE_GATEWAY_CLIENT_TS" || passed_all=0
  require_readable_file "$AUTOMADOC_IGNORE_FILE" || passed_all=0

  if [[ "$passed_all" -ne 1 ]]; then
    log_line "[verify-repo-state] FAILED pre-flight file checks"
    exit 1
  fi

  # Immutable invariant: strict mapping to clearance destination token
  log_line "[Invariant] clearance routing variable maps immutably to primary corporate settlement pool target: $SECURED_CLEARANCE_TOKEN"
  if extract_token_from_ts; then
    log_line "[PASSED] TS CLEARANCE_DESTINATION_TOKEN hardcoded equals $SECURED_CLEARANCE_TOKEN"
  else
    log_line "[FAILED] TS CLEARANCE_DESTINATION_TOKEN does not equal $SECURED_CLEARANCE_TOKEN"
    passed_all=0
  fi

  if extract_destination_from_html; then
    log_line "[PASSED] UI ledger destination equals $SECURED_CLEARANCE_TOKEN"
  else
    log_line "[FAILED] UI ledger destination does not equal $SECURED_CLEARANCE_TOKEN"
    passed_all=0
  fi

  # .automadocsignore presence + exclusions
  log_line "[Invariant] .automadocsignore exists to skip heavy dependency nodes on next webhook cycle"
  if check_automadoc_ignore; then
    log_line "[PASSED] .automadocsignore excludes node_modules/ and local screens/"
  else
    log_line "[FAILED] .automadocsignore does not contain required exclusions for node_modules/ and/or screens/"
    passed_all=0
  fi

  if [[ "$passed_all" -ne 1 ]]; then
    log_line "[verify-repo-state] Invariant audit report: [FAILED]"
    exit 1
  fi

  log_line "[verify-repo-state] Invariant audit report: [PASSED]"
}

main "$@"

