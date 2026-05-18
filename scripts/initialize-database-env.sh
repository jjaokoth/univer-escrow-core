#!/usr/bin/env bash
set -euo pipefail

# scripts/initialize-database-env.sh
# ----------------------------------
# Isolated initialization script for bootstrapping baseline collections.
# - Does NOT hardcode production credentials.
# - Relies strictly on environment configuration arguments/variables.
# - Creates tenant/escrow collections as needed (documents can be seeded).
# - Optionally writes baseline indices/hint documents for host initialization.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${FIRESTORE_EMULATOR_HOST:=}" # e.g. localhost:8080
: "${GOOGLE_CLOUD_PROJECT:=}"    # optional for non-emulator
: "${TENANT_ID:=}"              # required if seeding a baseline tenant
: "${ADMIN_UID:=}"             # required if creating admin-owned tenant doc

usage() {
  echo "Usage:" >&2
  echo "  FIRESTORE_EMULATOR_HOST=... GOOGLE_CLOUD_PROJECT=... TENANT_ID=... ADMIN_UID=... bash scripts/initialize-database-env.sh" >&2
  exit 2
}

if [[ -z "${TENANT_ID}" || -z "${ADMIN_UID}" ]]; then
  usage
fi

# Connectivity check (best effort)
if [[ -n "${FIRESTORE_EMULATOR_HOST}" ]]; then
  echo "[INFO] Using Firestore emulator at: ${FIRESTORE_EMULATOR_HOST}"
else
  echo "[INFO] GOOGLE_CLOUD_PROJECT not set; attempting production initialization requires host credentials via gcloud/application-defaults."
fi

# Requires firebase-tools or a host-provided admin SDK.
# We support two modes:
# 1) If firebase CLI is present, use it to seed.
# 2) Otherwise exit with a clear instruction.

if command -v firebase >/dev/null 2>&1; then
  echo "[INFO] firebase CLI detected. Seeding baseline documents..."

  # Ensure a minimal tenant doc exists.
  # Note: Firestore rules require request.auth.uid == tenantId for tenant writes.
  # In emulator/dev this typically maps to emulator auth.
  # Host environments should run with correct authentication context.
  firebase --version >/dev/null

  node - <<'NODE'
const project = process.env.GOOGLE_CLOUD_PROJECT || undefined;
const tenantId = process.env.TENANT_ID;
const adminUid = process.env.ADMIN_UID;
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

async function main() {
  // Prefer admin SDK if available in the repo toolchain.
  let admin;
  try {
    admin = require('firebase-admin');
  } catch {
    console.error('[FATAL] firebase-admin not available. Install it or run via host admin initializer.');
    process.exit(1);
  }

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: project });
  }

  const fs = admin.firestore();
  if (emulatorHost) {
    // In firebase-admin, emulator targeting typically requires setting FIRESTORE_EMULATOR_HOST env.
    // We'll rely on that env var being honored by the runtime.
    console.log('[INFO] Emulator targeting via FIRESTORE_EMULATOR_HOST env:', emulatorHost);
  }

  const tenantRef = fs.collection('tenants').doc(tenantId);
  const snap = await tenantRef.get();

  if (!snap.exists) {
    await tenantRef.set({
      tenantId,
      displayName: tenantId,
      platformFlags: {
        enableSurchargeMode: true,
        allowMultiplePaymentProviders: true,
        integrityEnforcement: true
      },
      operationalState: 'ACTIVE',
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: adminUid,
      publicTelemetryEnabled: false
    });
    console.log('[OK] Seeded tenant document');
  } else {
    console.log('[OK] Tenant document already exists; skipping');
  }
}

main().catch((e)=>{ console.error(e); process.exit(1); });
NODE

else
  echo "[FATAL] firebase CLI not found. This script requires either:"
  echo "  - firebase-tools installed and authenticated, with firebase-admin available for the seeding node step, or"
  echo "  - replace this script with your host SDK initializer." >&2
  exit 1
fi

echo "[OK] Database environment initialization complete."

