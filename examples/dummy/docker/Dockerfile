# One image, every role. ROLE selects behaviour at start, so there is exactly one artifact to
# promote — the image that passed staging is the image production runs.
#
#   x build --target docker --tag postly:$(git rev-parse --short HEAD)
#   docker run --rm -e ROLE=migrate -e DATABASE_URL=... postly:...   # release phase
#   docker run -e ROLE=web -e PORT=8080 -p 8080:8080 -e DATABASE_URL=... postly:...
#
# syntax=docker/dockerfile:1

# ---------- deps: runtime dependencies only, cached on the workspace manifests ----------
# The tag names the series for the reader; the digest is what builds. A tag is a pointer its
# publisher can move, so the same commit could build on a different base tomorrow. Dependabot's
# docker ecosystem moves the digest together with the tag.
FROM oven/bun:1.4-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS deps
WORKDIR /app
COPY package.json bun.lock ./
# The workspace members' manifests are what `bun install` resolves against; their sources are not.
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --production

# ---------- runtime ----------
# No build stage and no second gate: `x verify` is the gate and `x build` runs the static steps
# before it ever calls `docker build`. Re-running typecheck and lint here would need the
# devDependencies the `--production` install above deliberately leaves out — which is exactly how
# a build stage came to run `tsc` and `biome` against a tree that had neither.
FROM oven/bun:1.4-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ---------- prebuilt: every island chunk and compiled stylesheet, made once, here ----------
# What a web pod otherwise makes on EVERY boot — Babel over every island, Sass over every
# stylesheet: seconds of CPU and a compiler's worth of memory, per replica, per start. It runs in
# the image build because the store is valid only for the Bun and the paths that wrote it; above
# BUILD_ID, so two images differing only by their stamp share this layer; and above
# NODE_ENV=production, because it imports the app with no deployment environment and app.config.ts
# must ask for none — exactly as on a fresh clone. An image without this line still serves, and
# every boot logs X_IMAGE_NOT_PREBUILT naming it.
RUN bun node_modules/@ultimat3/cli/src/bin.ts build --target prebuilt

# The immutable content hash this image serves. Stamped by CI (`--build-arg BUILD_ID=$(git rev-parse HEAD)`);
# without one the server computes the same hash from the manifest at boot. Never `latest`.
ARG BUILD_ID=
ENV NODE_ENV=production \
    ROLE=web \
    PORT=3000 \
    BUILD_ID=${BUILD_ID}

# Documentation only — the platform decides the real port and injects it as PORT. The server binds
# whatever arrives, on 0.0.0.0, because a container bound to localhost is unreachable through its
# own port mapping, its load balancer and every health probe alike.
EXPOSE 3000

# The probe for the roles that SERVE HTTP — `web` and `sync`. /readyz flips to 503 on SIGTERM
# *before* the socket closes, so a rolling restart drains in-flight work instead of dropping it.
# Every other role opens the scrape listener alone and never binds $PORT, so each one overrides
# this in docker/docker-compose.prod.yml rather than reporting `unhealthy` for its whole life.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD \
  bun --eval "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# `.x/` is where any binding that is still embedded keeps its state — the local storage disk, and
# PGlite if DATABASE_URL is unset. Owned by the runtime user, because /app is not: the alternative
# is a non-root process failing at boot on a directory it is the only one that ever writes.
RUN mkdir -p /app/.x && chown -R bun:bun /app/.x

USER bun
# apps/web/server.ts reads ROLE and PORT and nothing else. `migrate` applies the migrations and
# exits; every other role serves until SIGTERM.
ENTRYPOINT ["bun", "apps/web/server.ts"]
