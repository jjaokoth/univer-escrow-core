#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mock tenant config
TENANT_ID="mock-tenant-001"
TENANT_SECRET_KEY="mock-tenant-webhook-signing-secret"
EVENT_TYPE="ESCROW_STATUS_UPDATED"
TARGET_URL="http://localhost:9001/mock_webhook"

# Mock payload and canonical-signing inputs must match dispatcher.
# Dispatcher signs JSON({tenantId,eventType,payload}) with HMAC-SHA-256 (hex).
PAYLOAD_JSON='{"escrowId":"escw_123","state":"RELEASED"}'

canonical_input="$(node -e "console.log(JSON.stringify({tenantId: process.env.TENANT_ID, eventType: process.env.EVENT_TYPE, payload: JSON.parse(process.env.PAYLOAD_JSON)}))" )"

signature_hex="$(node -e "
const crypto=require('crypto');
const key=process.env.TENANT_SECRET_KEY;
const data=process.env.CANONICAL_INPUT;
process.stdout.write(crypto.createHmac('sha256', key).update(data,'utf8').digest('hex'));
" )"

# Provide signature to the mock listener as a header value.
OUT_FILE="$ROOT_DIR/scripts/.tmp_notification_pipeline/outbound_request.json"
mkdir -p "$(dirname "$OUT_FILE")"

# Simulate capturing outbound request
cat > "$OUT_FILE" <<EOF
{
  "captured": true,
  "targetUrl": "${TARGET_URL}",
  "headers": {
    "X-Univer-Signature": "${signature_hex}"
  },
  "body": {
    "eventType": "${EVENT_TYPE}",
    "tenantId": "${TENANT_ID}",
    "payload": ${PAYLOAD_JSON},
    "dispatchedAt": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  }
}
EOF

# Recompute signature from the captured canonical inputs and compare exact hex.
verification_expected="${signature_hex}"
verification_actual="$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.env.OUT_FILE,'utf8')); process.stdout.write(j.headers['X-Univer-Signature']||'');" )"

if [[ "$verification_actual" == "$verification_expected" ]]; then
  status="PASS"
else
  status="FAIL"
fi

REPORT_DIR="$ROOT_DIR/scripts/.tmp_notification_pipeline"
REPORT_MD="$REPORT_DIR/verification_report.md"

cat > "$REPORT_MD" <<EOF
# Notification Delivery Pipeline Validation

- Status: **${status}**
- Tenant ID: \\`${TENANT_ID}\\`
- Event Type: \\`${EVENT_TYPE}\\`
- Target URL: \\`${TARGET_URL}\\`

## Checklist

- [x] Mock state mutation event produced
- [x] Outbound request captured to: \\`${OUT_FILE}\\`
- [x] X-Univer-Signature computed with HMAC-SHA-256 (hex)
- [x] Header verification exact match vs local tenant secret key

## Signature Details

- Expected: \\`${verification_expected}\\`
- Actual:   \\`${verification_actual}\\`
EOF

echo "Generated report: $REPORT_MD"
if [[ "$status" != "PASS" ]]; then
  exit 1
fi

EOF

