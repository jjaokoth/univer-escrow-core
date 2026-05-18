# syntax=docker/dockerfile:1

# Multi-stage build:
# - Stage 1: compile (universal type validation)
# - Stage 2: production runtime (minimal)

## Stage 1: compile & validate
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (monorepo root)
COPY package*.json ./
COPY securerise/package*.json ./securerise/
COPY univer-escrow-core/package*.json ./univer-escrow-core/

# Install only what exists; tolerate missing lockfiles.
RUN npm -s ci --workspaces=false || npm -s i

# Copy source
COPY . .

# Ensure scripts are executable
RUN chmod +x scripts/compile-universal.sh || true

# Run universal compilation validation
RUN bash scripts/compile-universal.sh

## Stage 2: production runtime
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Minimal artifacts for runtime usage.
# This repository is a framework; runtime packaging can be customized per deployment.
# Copy isomorphic runtime sources (no private code exposure).
COPY --from=builder /app/src ./src
COPY --from=builder /app/src/@types ./src/@types

# Copy any package metadata needed by the host runtime.
COPY securerise/package.json ./securerise/package.json

# Default command (no assumptions about entrypoint in this framework repo)
CMD ["node", "-e", "console.log('Univer-Escrow framework image built successfully')"]

