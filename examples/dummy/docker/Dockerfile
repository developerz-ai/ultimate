# One image, N roles. ROLE selects behaviour at runtime; the build is identical for all of them.
# Deploy anywhere = containers only — no platform primitives.

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/
COPY packages/mcp/package.json packages/mcp/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
# Stamps an immutable content-hash build id into sw.js, the HTML, every asset path,
# and x.manifest.json. Never a timestamp, never `latest` — that is what causes version skew.
RUN bun run build

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --uid 10001 --create-home postly
COPY --from=build --chown=postly:postly /app/dist ./dist
COPY --from=build --chown=postly:postly /app/node_modules ./node_modules
COPY --from=build --chown=postly:postly /app/x.manifest.json ./x.manifest.json
USER postly
EXPOSE 3000

# Every role serves /healthz + /readyz and drains on SIGTERM.
HEALTHCHECK --interval=10s --timeout=2s --start-period=20s \
  CMD bun --eval "await fetch('http://127.0.0.1:3000/readyz').then(r => process.exit(r.ok ? 0 : 1))"

ENV ROLE=web
ENTRYPOINT ["bun", "dist/server.js"]
