# The framework's own CLI image: `x`, compiled to one self-contained binary, on distroless.
#
#   docker build -f docker/Dockerfile -t ultimate-cli:dev .
#   docker run --rm ultimate-cli:dev --version
#   docker run --rm ultimate-cli:dev doctor --json
#
# NOT an app image, and this header said it was until 2026-08: "One image, every role. ROLE selects
# behaviour at start", with `docker run -e ROLE=worker` beside it. That promise belongs to an APP
# image and this one cannot keep it — the final stage below contains `/app/x` and nothing else, `x`
# has no `serve` command, and `ROLE` is read by `runRole()` (packages/cli/src/serve.ts:358), which
# is a LIBRARY export an app's `apps/web/server.ts` calls. There is no app in this build context to
# call it.
#
# An app's image is written by `x new` (packages/cli/src/templates/scaffold-container.ts) and built
# by `x build --target docker`, which compiles the APP's own `docker/Dockerfile`
# (packages/cli/src/cmd-build.ts, `BUILD_ENTRY.docker` — an app-root-relative path, never this
# file). That image is `ENTRYPOINT ["bun", "apps/web/server.ts"]` with no CMD, and it is the one
# that keeps the one-image-every-role promise.
#
# What this file is for, since nothing deploys it: it is the only artifact in the repository that
# proves the `--compile` + `--define ULTIMATE_FRAMEWORK_VERSION` + distroless-libc chain end to end
# on a shipping binary — the chain `x build --target binary` generates and nothing else executes.
# Four separate bugs in that chain are recorded in the stage comments below, each found by building
# this file. `.github/workflows/ci.yml`'s `container` job is what now builds it on every push.
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
      --external @babel/preset-typescript \
      --outfile /out/app \
      ./packages/cli/src/bin.ts \
 && chmod +x /out/app

# ---------- runtime: distroless, non-root, no shell ----------
# `cc-*` rather than `base-*`: a Bun single-file executable links against libstdc++, which base does
# not carry. The header here claimed "roughly 80MB total" and no version of this image has ever been
# that: `--compile` bakes the Bun runtime in, so `/app/x` alone is 104MB and the image measures
# 189MB (`docker images`, linux/amd64, `As of 2026-08`).
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
# `ROLE=web` was here, under "ROLE is the only knob", and nothing in this image has ever read it:
# `roleFromEnv` is reached only through `serveApp`/`runRole`, which no `x` subcommand calls. An
# operator reading it concluded the image serves. `PORT` stays because a command in this image does
# read it (`x db branch`, packages/cli/src/cmd-db-branch.ts:152, for the preview URL).
ENV PORT=3000 \
    NODE_ENV=production
# No EXPOSE. It listed 3000/3001/9090 as "every port a role in this image can open", which is the
# same false premise as the ROLE default above — no role runs here and the default command opens no
# socket at all. EXPOSE is metadata read by `docker run -P`, registry UIs and operators deciding
# what to publish, so a set of ports nothing binds misdocuments the image to exactly the audiences
# the old comment named. The app image is where those ports are real.
USER nonroot:nonroot
# The guard, now on the image that ships and as the user that runs it. A binary that cannot exec —
# wrong libc, wrong Debian, wrong permissions, or no `--version` because the `--define` above went
# missing — fails `docker build` instead of the first command an operator runs.
#
# Exec form is not a style choice: distroless carries no shell, and shell-form `RUN` is
# `/bin/sh -c`, which is the very thing this stage does not have.
RUN ["/app/x", "--version"]
# No HEALTHCHECK: this image runs a command and exits, so there is nothing to keep probing. In an
# APP image the probe belongs where the role is chosen — `healthcheck:` per service in
# docker-compose.prod.yml, and per-role readiness/liveness in docker/helm/templates/_helpers.tpl,
# because `worker`, `scheduler` and `replicator` open no application listener and one probe baked
# into a six-role image is wrong for half of them.
ENTRYPOINT ["/app/x"]
# No CMD. `x` with no arguments prints its command catalogue and exits 0, which is the honest
# default for a CLI image and leaves no argv variant to get wrong — the same reason the app image
# ships none.
#
# It was `CMD ["dev", "--once"]`: a production image defaulting to the DEV SERVER. `x dev` takes
# `--role` as a flag, defaults to every role in `DEV_ROLES`, and never reads `ROLE`
# (packages/cli/src/cmd-dev.ts:187,283); `--once` is documented "boot, report, exit — for smoke
# tests and CI" (:285). So every service in a compose file running this image booted the dev
# server, printed a report, exited 0 and was restarted by `restart: unless-stopped` — an infinite
# boot loop — and `run --rm migrate` applied no migration and exited 0, so a release phase
# succeeded having done nothing. The chart sets no `command`/`args` either, so every Deployment
# would CrashLoopBackOff while the pre-upgrade migrate Job reported Complete.
#
# `.github/workflows/ci.yml`'s `container` job runs this image with no arguments and requires the
# catalogue on stdout, so a CMD that boots something is a red build rather than a red pod.
