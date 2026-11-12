# SPDX-License-Identifier: AGPL-3.0-or-later
# La Caisse webapp as a container for Citizen Pay's self-hosted platform.
# Everything about running it is in docs/container.md. Vercel does not use
# this file: without NEXT_OUTPUT the Next config is the one Vercel builds.
#
# Base image: node:22-bookworm-slim (Node 22, like CI), pinned by the digest
# of its multi-arch index, which lists linux/amd64 and linux/arm64. Refresh:
#   docker buildx imagetools inspect node:22-bookworm-slim
# and copy the top "Digest:" line here (check both platforms are listed).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ---------------------------------------------------------------------------
# base: OpenSSL for Prisma's migration engine (release command) and the CA
# store it verifies against when no DATABASE_CA_CERT is given.
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
# build: install from the lockfile, build the standalone server, bundle the
# seed, collect the Prisma CLI for the release command.
FROM base AS build
WORKDIR /src
COPY package.json package-lock.json ./
# `npm ci` runs the postinstall (prisma generate + licenses), which needs the
# schema, the Prisma config and the license script.
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY scripts/generate-licenses.mjs ./scripts/generate-licenses.mjs
RUN npm ci
COPY . .
# No secret and no database at build time. The build only needs
# DATABASE_URL to be present (services/db/prisma.ts throws at import
# without it while Next collects route configuration); it never connects.
# The placeholder lives in this one RUN, not in an ENV of any stage.
RUN NEXT_OUTPUT=standalone \
    DATABASE_URL=postgresql://build-placeholder@127.0.0.1:9/none \
    npm run build
# Release tooling: docker/release.mjs, the seed as one bundled file, the
# Prisma config + schema + migrations, and the Prisma CLI with its
# dependencies exactly as installed above.
RUN mkdir -p /release \
 && cp docker/release.mjs prisma.config.ts /release/ \
 && cp -r prisma /release/prisma \
 && npx esbuild scripts/seed-staging.ts --bundle --platform=node --format=esm \
      --target=node22 --outfile=/release/seed-staging.mjs --external:pg-native \
      --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
      --log-level=warning \
 && node docker/collect-deps.mjs /src /release/node_modules prisma dotenv

# ---------------------------------------------------------------------------
# runtime
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DEPLOY_TARGET=container
# Owned by root, read-only for the app user; only Next's cache is writable.
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/.next/static ./.next/static
COPY --from=build /src/public ./public
COPY --from=build /release ./release
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
# Next's server handles SIGTERM: it stops accepting, finishes in-flight
# requests and pending after() callbacks, then exits (143).
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
