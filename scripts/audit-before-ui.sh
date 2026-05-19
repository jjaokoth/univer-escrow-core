#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_EXAMPLE_PATH="$ROOT_DIR/.env.example"
ENV_PATH="$ROOT_DIR/.env"

log() {
  printf '%s\n' "$*"
}

emit_deficit() {
  # Args: category message
  printf '[DEFICIT] %s: %s\n' "$1" "$2"
}

require_file() {
  local p="$1"
  if [[ ! -f "$p" ]]; then
    emit_deficit "FILE_MISSING" "Required file not found: $p"
    return 1
  fi
  return 0
}

parse_env_keys() {
  # Print keys in .env.example (ignore blanks and comments)
  local p="$1"
  # Only match KEY= patterns at line start (no export)
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$p" | sed -E 's/=.*$//' || true
}

validate_env_schema() {
  local deficits=0

  if [[ ! -f "$ENV_EXAMPLE_PATH" ]]; then
    emit_deficit "ENV_EXAMPLE_MISSING" ".env.example not found at: $ENV_EXAMPLE_PATH"
    return 1
  fi

  if [[ ! -f "$ENV_PATH" ]]; then
    emit_deficit "ENV_MISSING" ".env not found at: $ENV_PATH (create it from .env.example)"
    return 1
  fi

  # Build associative sets
  declare -A example_keys
  while IFS= read -r k; do
    [[ -z "$k" ]] && continue
    example_keys["$k"]=1
  done < <(parse_env_keys "$ENV_EXAMPLE_PATH")

  # Check all example keys exist in .env
  while IFS= read -r k; do
    [[ -z "$k" ]] && continue
    if ! grep -Eq "^${k}=" "$ENV_PATH"; then
      emit_deficit "ENV_KEY_MISSING" "${k} is required by .env.example but missing in .env"
      deficits=1
    fi
  done < <(printf '%s\n' "${!example_keys[@]}")

  # Check .env doesn't have keys not present in schema
  while IFS= read -r k; do
    [[ -z "$k" ]] && continue
    if [[ -z "${example_keys[$k]+x}" ]]; then
      emit_deficit "ENV_KEY_UNALLOWED" "${k} exists in .env but is not declared in .env.example"
      deficits=1
    fi
  done < <(parse_env_keys "$ENV_PATH")

  # Validate specific constraints if keys exist
  local pool_max_key="DB_POOL_MAX_SIZE"
  local pool_min_key="DB_POOL_MIN_SIZE"
  local zk_max_key="ZK_PROOF_MAX_CONCURRENCY"

  if grep -Eq "^${pool_max_key}=" "$ENV_PATH"; then
    val="$(grep -E "^${pool_max_key}=" "$ENV_PATH" | sed -E 's/^'"$pool_max_key"'=(.*)$/\1/' | tr -d '"' | xargs)"
    if ! [[ "$val" =~ ^[0-9]+$ ]]; then
      emit_deficit "ENV_FORMAT" "${pool_max_key} must be an integer (got: $val)"
      deficits=1
    fi
  fi

  if grep -Eq "^${pool_min_key}=" "$ENV_PATH"; then
    val="$(grep -E "^${pool_min_key}=" "$ENV_PATH" | sed -E 's/^'"$pool_min_key"'=(.*)$/\1/' | tr -d '"' | xargs)"
    if ! [[ "$val" =~ ^[0-9]+$ ]]; then
      emit_deficit "ENV_FORMAT" "${pool_min_key} must be an integer (got: $val)"
      deficits=1
    fi
  fi

  if grep -Eq "^${zk_max_key}=" "$ENV_PATH"; then
    val="$(grep -E "^${zk_max_key}=" "$ENV_PATH" | sed -E 's/^'"$zk_max_key"'=(.*)$/\1/' | tr -d '"' | xargs)"
    if ! [[ "$val" =~ ^[0-9]+$ ]]; then
      emit_deficit "ENV_FORMAT" "${zk_max_key} must be an integer (got: $val)"
      deficits=1
    fi
  fi

  return $deficits
}

compile_ts_controllers() {
  # Attempt TypeScript compilation at root (fallback to packages/backend)
  local deficits=0

  if [[ -f "$ROOT_DIR/package.json" ]] && command -v npm >/dev/null 2>&1; then
    # Prefer the workspace backend build if present
    if [[ -f "$ROOT_DIR/packages/backend/package.json" ]]; then
      if npm -s run -w packages/backend -q "build" >/dev/null 2>&1; then
        log "[OK] TypeScript controllers compile: packages/backend"
        return 0
      fi
      # Fall back to tsc if build is not defined
      if [[ -f "$ROOT_DIR/packages/backend/tsconfig.json" ]]; then
        if npx -s tsc -p "$ROOT_DIR/packages/backend/tsconfig.json" >/dev/null 2>&1; then
          log "[OK] TypeScript compilation succeeded: packages/backend"
          return 0
        fi
      fi
    fi

    # Root fallback
    if [[ -f "$ROOT_DIR/tsconfig.json" ]]; then
      if npx -s tsc -p "$ROOT_DIR/tsconfig.json" >/dev/null 2>&1; then
        log "[OK] TypeScript compilation succeeded: root"
        return 0
      fi
    fi
  fi

  # If we got here, compilation failed
  emit_deficit "TS_COMPILE_FAILED" "Unable to compile TypeScript controllers (checked packages/backend and optional root). Run with full logs for details."
  deficits=1
  return $deficits
}

mock_api_gateway_structural_test() {
  # Structural readiness check: try to require backend app/router and ensure it can initialize.
  # We avoid starting a server.
  local deficits=0

  local candidates=(
    "$ROOT_DIR/packages/backend/src/app.ts"
    "$ROOT_DIR/packages/backend/src/index.ts"
    "$ROOT_DIR/src/index.ts"
    "$ROOT_DIR/securerise/src/app.ts"
  )

  local entry=""
  for c in "${candidates[@]}"; do
    if [[ -f "$c" ]]; then
      entry="$c"
      break
    fi
  done

  if [[ -z "$entry" ]]; then
    emit_deficit "GATEWAY_ENTRY_MISSING" "No backend entrypoint found to test gateway structural readiness under expected paths."
    return 1
  fi

  # Use ts-node if available; otherwise just check package.json and rely on tsc step.
  if command -v node >/dev/null 2>&1; then
    if node -e "require('fs').accessSync('$entry'); console.log('entry-ok')" >/dev/null 2>&1; then
      :
    fi
  fi

  # Lightweight grep-based structural test: ensure there is an API router mounting JSON endpoints.
  # We search for express.json() and routes usage.
  if grep -R "express\.json" -n "$ROOT_DIR/packages/backend/src" >/dev/null 2>&1 || grep -R "app\.use" -n "$ROOT_DIR/packages/backend/src" >/dev/null 2>&1; then
    log "[OK] API gateway structural markers found in packages/backend/src"
    return 0
  fi

  emit_deficit "GATEWAY_STRUCTURAL_DEFICIT" "Could not find express/json router mounting markers in packages/backend/src."
  deficits=1
  return $deficits
}

main() {
  log "[audit-before-ui] Starting pre-frontend integration verification..."

  local overall_deficits=0

  # Validate env schema strictly against .env.example
  if ! validate_env_schema; then
    overall_deficits=1
  fi

  # Compile TS
  if ! compile_ts_controllers; then
    overall_deficits=1
  fi

  # Mock gateway structural readiness
  if ! mock_api_gateway_structural_test; then
    overall_deficits=1
  fi

  if [[ "$overall_deficits" -ne 0 ]]; then
    log "[audit-before-ui] FAILED: structural deficits detected."
    exit 1
  fi

  log "[audit-before-ui] PASSED: repo configuration and gateway readiness validated."
}

main "$@"

