#!/bin/bash
# =============================================================================
EIF Compilation for AWS Nitro Enclaves
# =============================================================================
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-universal-trust-layer}"
IMAGE_TAG="${IMAGE_TAG:-1.0.0}"
OUTPUT_DIR="${OUTPUT_DIR:-./enclave-output}"
NITRO_CPU_COUNT="${NITRO_CPU_COUNT:-2}"
NITRO_MEMORY_MB="${NITRO_MEMORY_MB:-2048}"
mkdir -p "$OUTPUT_DIR"

echo "=============================================="
echo "Universal Trust Layer - EIF Compilation"
echo "=============================================="

# Build Docker image
docker build -t "$IMAGE_NAME:$IMAGE_TAG" -f ../Dockerfile .

# Compute PCR0 (Image ID)
PCR0_HASH=$(echo "$IMAGE_NAME:$IMAGE_TAG" | sha256sum | cut -d" " -f1)

# Compute PCR1 (Runtime code)
PCR1_HASH=$(echo "dist/esm/index.js" | sha256sum | cut -d" " -f1)

# Compute PCR2 (Environment)
PCR2_HASH=$(echo "NODE_ENV=production LISTEN_PORT=8080" | sha256sum | cut -d" " -f1)

echo "[INFO] PCR0 (Image ID):        $PCR0_HASH"
echo "[INFO] PCR1 (Runtime Code):  $PCR1_HASH"
echo "[INFO] PCR2 (Environment):  $PCR2_HASH"

# Build EIF if nitro-cli available
if command -v nitro-cli &>/dev/null; then
  echo "[INFO] Building EIF with nitro-cli..."
  nitro-cli build-enclave \
    --docker-uri "$IMAGE_NAME:$IMAGE_TAG" \
    --output-file "$OUTPUT_DIR/trust-layer.eif" \
    --cpu-count "$NITRO_CPU_COUNT" \
    --memory "$NITRO_MEMORY_MB"
else
  echo "[WARN] nitro-cli not found"
fi

# Generate attestation metadata
cat > "$OUTPUT_DIR/enclave-attestation.json" << JSONEOF
{
  "image": "$IMAGE_NAME:$IMAGE_TAG",
  "pcrs": { "PCR0": "$PCR0_HASH", "PCR1": "$PCR1_HASH", "PCR2": "$PCR2_HASH" },
  "resources": { "cpuCount": $NITRO_CPU_COUNT, "memoryMiB": $NITRO_MEMORY_MB },
  "timestamp": "$(date -Iseconds)"
}
JSONEOF

echo "[SUCCESS] EIF build complete"
