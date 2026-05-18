#!/usr/bin/env bash
set -euo pipefail

# Universal TypeScript Compilation Validation Script
# ----------------------------------------------------
# Verifies that the core TypeScript code compiles under target-agnostic
# libraries (esnext + webworker) to prevent Node/legacy ecosystem leakage.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CORE_DIR="src"
TEMP_TSC_DIR=".tmp/compile-universal"

mkdir -p "$TEMP_TSC_DIR"

# Create a temporary tsconfig that forces target-agnostic libs.
cat > "$TEMP_TSC_DIR/tsconfig.universal.json" <<'JSON'
{
  "extends": "../../securerise/packages/backend/tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["esnext", "webworker"],
    "types": [],
    "skipLibCheck": true,
    "strict": true,
    "moduleResolution": "bundler"
  },
  "include": ["../../src/**/*.ts", "../../src/**/*.d.ts", "../../src/@types/**/*.d.ts"]
}
JSON

# Defensive checks: fail fast on Node-only globals/usages.
# (This is advisory; real prevention is through universal compilation.)
if rg -n "\bBuffer\b|\brequire\b|\bprocess\b|node:|crypto\.createHash|crypto\.randomBytes" "$CORE_DIR" >/dev/null 2>&1; then
  echo "[FATAL] Potential Node/legacy crypto/global usage detected in $CORE_DIR" >&2
  rg -n "\bBuffer\b|\brequire\b|\bprocess\b|node:|crypto\.createHash|crypto\.randomBytes" "$CORE_DIR" >&2
  exit 1
fi

# Ensure TypeScript is available.
if ! command -v npx >/dev/null 2>&1; then
  echo "[FATAL] npx not found" >&2
  exit 1
fi

# Run tsc in universal mode.
# Prefer local node_modules/.bin/tsc when available.

echo "[INFO] Running universal compilation: tsc --noEmit (esnext + webworker)"

LOCAL_TSC="./node_modules/.bin/tsc"
if [[ -x "$LOCAL_TSC" ]]; then
  "$LOCAL_TSC" --project "$TEMP_TSC_DIR/tsconfig.universal.json" >/dev/null
  echo "[OK] Universal compilation succeeded (local tsc)."
  exit 0
fi

# Fallback to npx if local tsc isn't available.
# If npx cannot resolve in restricted environments, callers should use bootstrap-runtime.sh.
npx -y typescript@latest \
  --project "$TEMP_TSC_DIR/tsconfig.universal.json" \
  >/dev/null

echo "[OK] Universal compilation succeeded."

