# Univer‑Escrow Onboarding Examples (External Integration Snippets)

> **Note:** These examples are **production-safe** templates. Replace placeholders with your own provisioned values.

## 0) Required Credentials (Provisioned by Univer‑Escrow)
- `clientId`: `ue_live_...` (public identifier)
- `secretKey`: `ue_secret_...` (keep confidential)
- (Optional) `x-securerise-integrity`: provided/derived per gateway policy

---

## 1) cURL / Bash — Initiate Transaction

```bash
BASE_URL="https://gateway.example.com"
CLIENT_ID="ue_live_abc123"
SECRET_KEY="ue_secret_xyz789"

AMOUNT="1250.00"
CURRENCY="KES"

# Transaction metadata as JSON (adjust keys as needed)
METADATA_JSON='{
  "tenantId": "tenant_001",
  "customerRef": "cust_0009"
}'

# Integrity signature header value is gateway-specific.
# If your gateway requires it, set INTEGRITY.
INTEGRITY=""

PAYLOAD=$(cat <<EOF
{
  "clientId": "${CLIENT_ID}",
  "amount": ${AMOUNT},
  "currency": "${CURRENCY}",
  "metadata": ${METADATA_JSON}
}
EOF
)

AUTH_HEADER="Authorization: Bearer ${SECRET_KEY}"

curl -sS -X POST "${BASE_URL}/api/v1/payments/initiate" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "${AUTH_HEADER}" \
  ${INTEGRITY:+-H "x-securerise-integrity: ${INTEGRITY}"} \
  -d "${PAYLOAD}" \
  | jq
```

---

## 2) Python (Requests) — Poll Transaction Status

```python
import os
import requests

BASE_URL = os.environ.get("UE_BASE_URL", "https://gateway.example.com")
SECRET_KEY = os.environ.get("UE_SECRET_KEY", "ue_secret_xyz789")

escrow_id = "your_escrow_id_here"

headers = {
    "Accept": "application/json",
    "Authorization": f"Bearer {SECRET_KEY}",
}

# Optional integrity header
# headers["x-securerise-integrity"] = os.environ.get("UE_INTEGRITY", "")

resp = requests.get(
    f"{BASE_URL}/api/v1/escrows/{escrow_id}",
    headers=headers,
    timeout=30,
)

try:
    resp_data = resp.json()
except ValueError:
    resp_data = {"raw": resp.text}

if not resp.ok:
    raise RuntimeError({"status": resp.status_code, "error": resp_data})

print("Status:", resp_data.get("status"))
print("Payload:", resp_data)
```

---

## 3) PHP (Guzzle) — Initiate Transaction

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

$baseUrl = getenv('UE_BASE_URL') ?: 'https://gateway.example.com';
$clientId = getenv('UE_CLIENT_ID') ?: 'ue_live_abc123';
$secretKey = getenv('UE_SECRET_KEY') ?: 'ue_secret_xyz789';

$amount = 1250.00;
$currency = 'KES';
$metadata = [
  'tenantId' => 'tenant_001',
  'customerRef' => 'cust_0009',
];

$client = new Client(['base_uri' => $baseUrl]);

$payload = [
  'clientId' => $clientId,
  'amount' => $amount,
  'currency' => $currency,
  'metadata' => $metadata,
];

$headers = [
  'Accept' => 'application/json',
  'Content-Type' => 'application/json',
  'Authorization' => 'Bearer ' . $secretKey,
  // Optional integrity header
  // 'x-securerise-integrity' => getenv('UE_INTEGRITY') ?: '',
];

try {
  $response = $client->post('/api/v1/payments/initiate', [
    'headers' => $headers,
    'json' => $payload,
  ]);

  $data = json_decode($response->getBody()->getContents(), true);
  echo "Success\n";
  print_r($data);
} catch (GuzzleException $e) {
  $status = $e->getCode();
  $body = $e->getResponse() ? (string)$e->getResponse()->getBody() : null;
  echo "Request failed (HTTP {$status})\n";
  echo $body ? $body . "\n" : "";
  throw $e;
}
```

---

## 4) Security Notes for Integrators
- Keep `secretKey` confidential.
- Do not log headers containing credentials.
- If your gateway enforces `x-securerise-integrity`, treat it as an authentication primitive and rotate upon incident response.

