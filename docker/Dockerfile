# One image, every role. ROLE selects behaviour at start; nothing else differs between the web,
# sync, worker, scheduler, migrate and replicator processes. Deploy anywhere = containers only.
#
#   docker build -f docker/Dockerfile -t ultimate-app:dev .
#   docker run -e ROLE=worker ultimate-app:dev
#
# syntax=docker/dockerfile:1

# ---------- manifests: every workspace package.json in the context, and nothing else ----------
# `bun install --frozen-lockfile` compares the lockfile against EVERY workspace member the root
# package.json claims. The deps stage listed three of them by hand — `package.json`, `packages`,
# `examples` — and `dummy/*` contributes seven more, so the install died with
# `error: lockfile had changes, but lockfile is frozen` and the framework's own image could not
# build at all. Reproduced on this tree with `docker build --target deps`.
#
# `COPY dummy ./dummy` would have fixed today and re-broken on the next workspace glob somebody
# adds, which is the same hand-maintained-list defect. This stage derives the set from the context
# instead: whatever `package.json` files exist are what the install sees. Same dependency graph the
# app really runs on — the identical lockfile and the identical manifests, no narrowed workspace
# set — so the image stays honest.
#
# Manifests only, not source: that is what makes the deps layer below cache on dependencies rather
# than on every line of code, which the header there had claimed and never done.
FROM oven/bun:1.3-slim AS manifests
WORKDIR /src
COPY . .
# `bunfig.toml` survives with the manifests, and it is not a convenience: its `[install]` section is
# input to `bun install`. Dropping it would let this stage install by different rules than a
# developer or CI does, which is the one thing this whole stage exists not to do.
RUN find . ! -type d ! -name package.json ! -name bunfig.toml -delete \
 && find . -type d -empty -delete

# ---------- deps: cached on the lockfile and the workspace manifests ----------
FROM oven/bun:1.3-slim AS deps
WORKDIR /src
COPY --from=manifests /src ./
COPY bun.lock ./
RUN bun install --frozen-lockfile

# ---------- build: one self-contained binary ----------
FROM oven/bun:1.3-slim AS build
WORKDIR /src
# The WHOLE installed tree, not just the root `node_modules`. Bun 1.3's default isolated linker
# stores every package once under `node_modules/.bun/` and symlinks it from the `node_modules/` of
# each workspace that declares it — `sass` for render, `nats` for realtime, every `@ultimat3/*`
# edge. `COPY --from=deps /src/node_modules` therefore copied the root tree and left all of those
# behind, and the compile died `Could not resolve: "sass"` / `"nats"` — a SECOND reason this image
# could not build, under the frozen-lockfile one and only reachable once that was fixed.
# Reproduced, then re-run green, with `docker build -f docker/Dockerfile .`.
#
# Copying the tree keeps the isolated layout the framework is really installed with. Re-installing
# with `--linker=hoisted` would also have compiled, and would have shipped a module resolution no
# developer and no CI job runs.
COPY --from=deps /src ./
# Source lands ON TOP of the install: `.dockerignore` drops every `node_modules`, so this merges
# into the tree above rather than replacing it.
COPY . .
# --compile bundles the runtime, so the final stage needs no Bun and no node_modules.
#
# The `--define` is not optional, and this image is why the caveat existed: a single-file
# executable carries no `package.json`, so `resolveVersion` finds no manifest, falls through to the
# define, and throws `X_INVARIANT` when it is absent too. The read is lazy, so the image did not
# die at import — it died at whichever command first asked for a version. `x build --target binary`
# has always passed it (`packages/cli/src/cmd-build.ts`, `binaryArgs`); the framework's own image
# did not, so the target was fixed everywhere except in the artifact we ship.
#
# `JSON.stringify` rather than bare interpolation: the define's value is parsed as a JS expression,
# so `1.2.0` unquoted is arithmetic and not a string.
RUN VERSION_DEFINE="$(bun --print 'JSON.stringify(require("./packages/core/package.json").version)')" \
 && bun build --compile --minify --sourcemap \
      --define ULTIMATE_FRAMEWORK_VERSION="$VERSION_DEFINE" \
      --outfile /out/app \
      ./packages/cli/src/bin.ts \
 && chmod +x /out/app

# ---------- runtime: distroless, non-root, no shell ----------
# `cc-*` rather than `base-*`: a Bun single-file executable links against libstdc++, which base does
# not carry. The header here claimed "roughly 80MB total" and no version of this image has ever been
# that: `--compile` bakes the Bun runtime in, so `/app/x` alone is 104MB and the image measures
# 189MB (`docker images`, 2026-08, linux/amd64).
#
# `-debian13`, and the digit is load-bearing: it must be the SAME Debian as the build stage above.
# `oven/bun:1.3-slim` is trixie (glibc 2.41) and `cc-debian12` is bookworm (glibc 2.36), so a binary
# built there could not have run here even if it had been built at all.
#
# It was worse than a version skew before this branch: the build stage was `oven/bun:1.3-alpine`, so
# the binary requested `/lib/ld-musl-x86_64.so.1` on a glibc-only runtime. Every container this
# image started died instantly with `exec /app/x: no such file or directory` — reproduced, and
# confirmed with `ldd`. The build was green, because the ONE thing that would have caught it ran on
# the wrong image: `/out/app --version` proved the binary runs on the BUILD stage, and the build
# stage is not what ships.
FROM gcr.io/distroless/cc-debian13:nonroot AS runtime
COPY --from=build /out/app /app/x
# ROLE is the only knob. Everything else comes from app.config.ts, validated at boot.
ENV ROLE=web \
    PORT=3000 \
    NODE_ENV=production
# Every port a role in this image can open: PORT for web, PORT+1 for sync (dev-roles.ts), and
# METRICS_PORT for the scrape listener every role but `migrate` opens. EXPOSE is metadata, so a
# missing entry costs nothing at runtime and misdocuments the image to everything that reads it —
# `docker run -P`, a registry UI, an operator deciding what to publish.
EXPOSE 3000 3001 9090
USER nonroot:nonroot
# The guard, now on the image that ships and as the user that runs it. A binary that cannot exec —
# wrong libc, wrong Debian, wrong permissions, or no `--version` because the `--define` above went
# missing — fails `docker build` instead of the first command an operator runs.
#
# Exec form is not a style choice: distroless carries no shell, and shell-form `RUN` is
# `/bin/sh -c`, which is the very thing this stage does not have.
RUN ["/app/x", "--version"]
# No HEALTHCHECK, deliberately. One image serves six roles and `worker`, `scheduler` and
# `replicator` open no HTTP listener at all, so any single probe baked in here is wrong for half of
# them — the exact shape of the bug that made sync's readiness probe meaningless. The probe belongs
# where the role is chosen: `healthcheck:` per service in docker-compose.prod.yml, and per-role
# readiness/liveness in docker/helm/templates/_helpers.tpl.
#
# All roles that serve HTTP expose /healthz and /readyz; every role drains on SIGTERM.
ENTRYPOINT ["/app/x"]
CMD ["dev", "--once"]
