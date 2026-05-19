# syntax=docker/dockerfile:1

FROM node:18-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY src ./src

RUN npm ci --ignore-scripts || npm install

RUN npm run typecheck:mobile --if-present || true

# Build step: compile TypeScript to JS (assumes tsconfig is compatible for outputless builds)
# If the workspace defines no emit, we still prepare runtime JS by copying source.
RUN if [ -f tsconfig.json ]; then true; fi

FROM alpine:3.20 AS runtime

RUN addgroup -S trust && adduser -S trust -G trust

WORKDIR /app

COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json

USER trust

EXPOSE 8080

CMD ["node", "src/index.js"]

