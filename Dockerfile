# =============================================================================
# Universal Trust Layer - Production Dockerfile for Confidential Computing
# =============================================================================
# Architecture: Multi-stage build for isolated MicroVM/Enclave environments
# Build Target: Node.js ESM + CommonJS dual-output with TypeScript compilation
# Security: Non-root user, no shell access, stripped npm/yarn, explicit env fallbacks
# Compatible: AWS Nitro Enclaves, GCP Confidential Space, Azure Confidential VMs
# =============================================================================

# -----------------------------------------------------------------------------
# STAGE 1: BUILD - Compile TypeScript and prepare artifacts
# -----------------------------------------------------------------------------
FROM node:20-alpine AS build

LABEL maintainer="Universal Trust Layer Contributors"
LABEL version="1.0.0"
LABEL description="Confidential Computing Trust Layer"

WORKDIR /workspace

RUN apk add --no-cache openssl curl git ca-certificates dumb-init tini && rm -rf /var/cache/apk/*

COPY package.json package-lock.json* ./
COPY tsconfig.json tsconfig.esm.json tsconfig.cjs.json ./


RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY scripts ./scripts

RUN npm run build:package 2>/dev/null || (npm run build:cjs && npm run build:esm)

RUN ls -la dist/esm/ dist/cjs/ && test -f dist/esm/index.js && test -f dist/cjs/index.js

# -----------------------------------------------------------------------------
# STAGE 2: RUNTIME - Minimal production image
# -----------------------------------------------------------------------------
FROM node:20-alpine-slim AS runtime

RUN addgroup -S enclave && adduser -S enclave -G enclave -D -s /sbin/nologin && rm -rf /bin/sh /bin/bash

WORKDIR /app

COPY --from=build /workspace/dist ./dist
COPY --from=build /workspace/package.json ./package.json

RUN mkdir -p /app/data /app/logs /app/secrets && chown -R enclave:enclave /app && chmod 700 /app/secrets

RUN apk add --no-cache ca-certificates dumb-init tini && rm -rf /var/cache/apk/*

RUN rm -f /usr/local/bin/npm /usr/local/bin/yarn /usr/local/bin/npx /usr/local/bin/node 2>/dev/null || true

RUN touch /app/.dockerenv /app/.enclave

USER enclave

ENV ENCLAVE_MRSIGNER=${ENCLAVE_MRSIGNER:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}
ENV ENCLAVE_MRENCLAVE=${ENCLAVE_MRENCLAVE:-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=}
ENV NODE_ENV=production
ENV LISTEN_PORT=${LISTEN_PORT:-8080}
ENV ENABLE_ATTESTATION=${ENCLAVE_ATTESTATION:-true}
ENV KMS_ENDPOINT=${KMS_ENDPOINT:-}
ENV LEDGER_STORE_PATH=/app/data/ledger-store.json

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

EXPOSE 8080

ENTRYPOINT ["tini", "--", "dumb-init", "--"]
CMD ["node", "dist/esm/index.js"]
