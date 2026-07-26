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
RUN bun build --compile --minify --sourcemap \
      --outfile /out/app \
      ./packages/cli/src/bin.ts \
 && chmod +x /out/app

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
