# One image, every role. ROLE selects behaviour at start; nothing else differs between the web,
# sync, worker, scheduler, migrate and replicator processes. Deploy anywhere = containers only.
#
#   docker build -f docker/Dockerfile -t ultimate-app:dev .
#   docker run -e ROLE=worker ultimate-app:dev
#
# syntax=docker/dockerfile:1

# ---------- deps: cached on the lockfile alone ----------
FROM oven/bun:1.3-alpine AS deps
WORKDIR /src
COPY package.json bun.lock ./
COPY packages ./packages
COPY examples ./examples
RUN bun install --frozen-lockfile

# ---------- build: one self-contained binary ----------
FROM oven/bun:1.3-alpine AS build
WORKDIR /src
COPY --from=deps /src/node_modules ./node_modules
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
 && chmod +x /out/app \
 && /out/app --version

# ---------- runtime: distroless, non-root, no shell ----------
# cc-debian12 rather than base-debian12: a Bun single-file executable links against libstdc++,
# which base does not carry. cc adds ~8MB and keeps the image at roughly 80MB total.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
COPY --from=build /out/app /app/x
# ROLE is the only knob. Everything else comes from app.config.ts, validated at boot.
ENV ROLE=web \
    PORT=3000 \
    NODE_ENV=production
EXPOSE 3000
USER nonroot:nonroot
# All roles expose /healthz and /readyz and drain on SIGTERM.
ENTRYPOINT ["/app/x"]
CMD ["dev", "--once"]
