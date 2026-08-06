# Multi-stage build.
#
# The runtime stage carries no compiler, no dev dependencies and no source —
# only the compiled output and production modules. That keeps the image small
# and, more usefully, keeps the attack surface of a container that holds live
# broker credentials down to what it actually needs to run.

FROM node:20-slim AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts

# tsconfig sets noEmit for the typecheck script, so emit explicitly here.
RUN npx tsc --noEmit \
 && npx tsc --outDir dist --declaration false --sourceMap false --noEmit false \
 && node scripts/build-console.js

# ---------------------------------------------------------------------------

FROM node:20-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web

# Migrations are read at runtime by Database.migrate(), and tsc does not copy
# non-TypeScript files into the output. Copied as a directory so a newly added
# migration cannot be left behind by a stale file list.
COPY src/persistence/migrations ./dist/persistence/migrations

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 8080

# The container is only healthy when the app says it is — this is the same
# check the load balancer uses, so a degraded dependency surfaces here too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
