# One image, every role. ROLE selects behaviour at start, so there is exactly one artifact to
# promote — the image that passed staging is the image production runs.
#
#   x build --target docker --tag social-media-clone:$(git rev-parse --short HEAD)
#   docker run --rm -e ROLE=migrate -e DATABASE_URL=... social-media-clone:...   # release phase
#   docker run -e ROLE=web -e PORT=8080 -p 8080:8080 -e DATABASE_URL=... social-media-clone:...
#
# syntax=docker/dockerfile:1

# ---------- manifests: every workspace package.json, and nothing else ----------
# The install below must be keyed on the MANIFESTS, not on the source: copying `apps` and
# `packages` ahead of `bun install` made every edit to a page a full reinstall. The set is derived
# from the context rather than listed, so a workspace glob added later is not a lockfile the frozen
# install refuses. `bunfig.toml` survives because its `[install]` section is input to the install,
# and so does a `.tgz`: a `file:` tarball dependency (a vendored or private package) is resolved
# from the file itself, and without it the frozen install cannot find what the lockfile names.
# The tag names the series for the reader; the digest is what builds — a tag is a pointer its
# publisher can move. Dependabot's docker ecosystem moves the digest together with the tag.
# The digest is `oven/bun:1.4.4-alpine`'s, the patch the framework that wrote this file was
# tested on — the same patch as `engines.bun` in package.json.
FROM oven/bun:1.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS manifests
WORKDIR /app
COPY . .
RUN find . ! -type d ! -name package.json ! -name bunfig.toml ! -name '*.tgz' -delete \
 && find . -type d -empty -delete

# ---------- deps: runtime dependencies only, cached on the lockfile and the manifests ----------
FROM oven/bun:1.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS deps
WORKDIR /app
COPY --from=manifests /app ./
COPY bun.lock ./
RUN bun install --frozen-lockfile --production

# ---------- runtime ----------
# No build stage and no second gate: `x verify` is the gate and `x build` runs the static steps
# before it ever calls `docker build`. Re-running typecheck and lint here would need the
# devDependencies the `--production` install above deliberately leaves out — which is exactly how
# a build stage came to run `tsc` and `biome` against a tree that had neither.
#
# Built ON the install stage, so the WHOLE installed tree comes with it — Bun's isolated linker
# links a workspace's dependencies under that workspace's own `node_modules`, and copying only the
# root one left `apps/web`'s behind — and the source lands on top (the ignore file drops every host
# `node_modules`, so the two merge). The layer cache is the same as a COPY from it would be.
FROM deps AS runtime
WORKDIR /app
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
# Numeric, and the same number docker/helm/values.yaml runs every pod as: 1000 is the base
# image's `bun` user, and a numeric USER is one a kubelet can check against runAsNonRoot.
RUN mkdir -p /app/.x && chown -R 1000:1000 /app/.x

USER 1000:1000
# apps/web/server.ts reads ROLE and PORT and nothing else. `migrate` applies the migrations and
# exits; every other role serves until SIGTERM.
ENTRYPOINT ["bun", "apps/web/server.ts"]
