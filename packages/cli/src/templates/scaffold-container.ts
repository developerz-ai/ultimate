// The container half of what `x new` writes: the image, what to ignore when building it, the
// production topology, and the one page that explains how a platform runs the release phase.
// Split from scaffold-docs.ts because these four are one subject and that file is another.
//
// Axiom 7 in file form. Nothing here names a cloud: `$PORT`, `0.0.0.0`, `/readyz` and a
// run-to-completion migrate step are conventions every container platform shares — a Heroku
// buildpack, a Render blueprint or a fly.toml would be the primitive that never ships.

import type { GeneratedFile, NameSet } from './naming';
import { helmFiles } from './scaffold-helm';

const dockerfile = (
  app: NameSet,
): string => `# One image, every role. ROLE selects behaviour at start, so there is exactly one artifact to
# promote — the image that passed staging is the image production runs.
#
#   x build --target docker --tag ${app.kebab}:$(git rev-parse --short HEAD)
#   docker run --rm -e ROLE=migrate -e DATABASE_URL=... ${app.kebab}:...   # release phase
#   docker run -e ROLE=web -e PORT=8080 -p 8080:8080 -e DATABASE_URL=... ${app.kebab}:...
#
# syntax=docker/dockerfile:1

# ---------- deps: runtime dependencies only, cached on the workspace manifests ----------
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# The workspace members' manifests are what \`bun install\` resolves against; their sources are not.
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --production

# ---------- runtime ----------
# No build stage and no second gate: \`x verify\` is the gate and \`x build\` runs the static steps
# before it ever calls \`docker build\`. Re-running typecheck and lint here would need the
# devDependencies the \`--production\` install above deliberately leaves out — which is exactly how
# a build stage came to run \`tsc\` and \`biome\` against a tree that had neither.
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The immutable content hash this image serves. Stamped by CI (\`--build-arg BUILD_ID=$(git rev-parse HEAD)\`);
# without one the server computes the same hash from the manifest at boot. Never \`latest\`.
ARG BUILD_ID=
ENV NODE_ENV=production \\
    ROLE=web \\
    PORT=3000 \\
    BUILD_ID=\${BUILD_ID}

# Documentation only — the platform decides the real port and injects it as PORT. The server binds
# whatever arrives, on 0.0.0.0, because a container bound to localhost is unreachable through its
# own port mapping, its load balancer and every health probe alike.
EXPOSE 3000

# The probe for the roles that SERVE HTTP — \`web\` and \`sync\`. /readyz flips to 503 on SIGTERM
# *before* the socket closes, so a rolling restart drains in-flight work instead of dropping it.
# Every other role opens the scrape listener alone and never binds $PORT, so each one overrides
# this in docker/docker-compose.prod.yml rather than reporting \`unhealthy\` for its whole life.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD \\
  bun --eval "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# \`.x/\` is where any binding that is still embedded keeps its state — the local storage disk, and
# PGlite if DATABASE_URL is unset. Owned by the runtime user, because /app is not: the alternative
# is a non-root process failing at boot on a directory it is the only one that ever writes.
RUN mkdir -p /app/.x && chown -R bun:bun /app/.x

USER bun
# apps/web/server.ts reads ROLE and PORT and nothing else. \`migrate\` applies the migrations and
# exits; every other role serves until SIGTERM.
ENTRYPOINT ["bun", "apps/web/server.ts"]
`;

/**
 * BuildKit prefers `<dockerfile>.dockerignore` over the context root's, so this sits beside the
 * Dockerfile. Without it `COPY . .` ships `node_modules` and `.x/` — a stale host `node_modules`
 * would shadow the `--production` install the deps stage just made.
 *
 * The `.env` block carries a recursive prefix for a reason measured against a real `docker build`.
 * An ignore pattern is anchored at the context root and crosses no directory on its own, so `.env`
 * plus `.env.*.local` matched NEITHER `.env.production` — the file `docker-compose.prod.yml` below
 * tells the operator to create, in its own `env_file:` — nor `.env.development`, and both landed in
 * an image layer that `cache-to=mode=max` then pushes to a shared cache. Same four lines the
 * framework's own `docker/Dockerfile.dockerignore` carries, and for the same reason.
 */
const dockerignore = (): string => `**/.env
**/.env.*
!**/.env.example
# Same shape, different file: an .npmrc carries a registry auth token, so any that exists in a
# build context is somebody's local credential and has no business in a layer.
**/.npmrc

node_modules
**/node_modules
**/.x
**/dist
**/*.tsbuildinfo
.git
coverage
**/test-results
**/playwright-report
`;

const composeProd = (
  app: NameSet,
): string => `# The production topology: one service per role, one image, differing only by ROLE and replicas.
# What \`x deploy --method compose\` runs. migrate runs to completion before anything serves.
#
#   IMAGE=ghcr.io/you/${app.kebab}:1.2.3 x deploy --image ghcr.io/you/${app.kebab}:1.2.3
#
# A published host port has exactly one binder, so \`web\` and \`sync\` run at 1 here. Compose is one
# box; horizontal scaling of those two belongs to an orchestrator — \`docker/helm\`, beside this
# file, is the chart \`x deploy --method helm\` installs. To scale them on one box anyway, drop
# \`ports:\` and put your own proxy on this network — the service name resolves to every replica
# over the compose DNS round robin.
name: ${app.kebab}

x-image: &image
  image: \${IMAGE:-${app.kebab}:dev}
  env_file: [../.env.production]
  restart: unless-stopped
  stop_grace_period: 30s # SIGTERM → drain in-flight requests, jobs and sockets
  depends_on:
    db: { condition: service_healthy }

# The image's own HEALTHCHECK fetches \`/readyz\` on $PORT, and only \`web\` and \`sync\` open an HTTP
# socket — every other role gets the scrape listener and nothing else. A service that inherits that
# probe is fetching a port it never binds: it reports \`unhealthy\` for its whole life and anything
# gated on it never starts. Probes follow the role here, exactly as they do in \`docker/helm\`.
x-metrics-probe: &metrics-probe
  test: ['CMD', 'bun', '--eval', "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9090)+'/metrics').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
  interval: 10s
  timeout: 3s
  start_period: 30s
  retries: 3

# Run-once services exit. A probe against an exited container reports \`unhealthy\` forever, and
# nothing waits on their health — \`service_completed_successfully\` is what the others gate on.
x-run-once-probe: &run-once-probe
  disable: true

services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: ${app.kebab}
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
    restart: unless-stopped

  # The release phase. Applies pending migrations under an advisory lock and exits; every serving
  # role waits for it to complete, so no replica ever serves against a schema it does not ship.
  migrate:
    <<: *image
    environment: [ROLE=migrate]
    restart: 'no'
    healthcheck: *run-once-probe

  # Run-once, AFTER the new version serves. Deliberately NOT part of the release gate: a slow
  # UPDATE there holds the deploy open against a database still serving the previous version.
  # Dry run is the default, so \`--write\` is explicit.
  backfill:
    <<: *image
    # The image's ENTRYPOINT is \`bun apps/web/server.ts\`, and that entry reads ROLE and PORT and
    # NOTHING ELSE — argv never reaches a parser. A bare \`command:\` is appended to it and silently
    # discarded, so this service used to serve HTTP as ROLE=web under a name that said otherwise.
    # Overriding the entrypoint is what makes the words below a command. The file path, not
    # \`node_modules/.bin/x\`: it needs no bin symlink and no executable bit inside the image.
    entrypoint: ['bun', 'node_modules/@ultimat3/cli/src/bin.ts']
    command: ['db', 'backfill', '--all', '--write', '--json']
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
      # The barrier, not the ordering. \`docker compose up -d\` returns when a container STARTS, so
      # listing this last would only look like "after". The image's HEALTHCHECK is what makes it true.
      web: { condition: service_healthy }
    restart: 'no'
    healthcheck: *run-once-probe

  web:
    <<: *image
    environment: [ROLE=web]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    deploy: { replicas: 1 } # stateless, scales on RPS — pinned by the published port
    ports: ['3000:3000']

  sync:
    <<: *image
    environment: [ROLE=sync]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    deploy: { replicas: 1 } # scales on concurrent websockets, no sticky sessions — pinned by the port
    # The sync role binds PORT + 1. PORT is unset here, so it is 3000 and this listens on 3001.
    ports: ['3001:3001']
    # ...which is why the image's own HEALTHCHECK cannot be inherited here. It fetches $PORT —
    # 3000 — and this role never binds it, so the container reports \`unhealthy\` from
    # \`start_period\` onward and never recovers, and anything gated on \`sync: service_healthy\`
    # would never start. Literal 3001 rather than an expression, for the same reason \`ports:\`
    # above is literal: PORT is unset in this file, and two ways of saying one number drift.
    # \`docker/helm\` states the same rule as \`PORT = .port - 1\`.
    healthcheck:
      test: ['CMD', 'bun', '--eval', "fetch('http://127.0.0.1:3001/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      start_period: 30s
      retries: 3

  worker:
    <<: *image
    environment: [ROLE=worker]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck: *metrics-probe
    deploy: { replicas: 1 } # scales on queue depth

  scheduler:
    <<: *image
    environment: [ROLE=scheduler]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    # Fixed 1. Leadership is an EXPIRING LEASE ROW in \`x_scheduler_leader\` (dev-roles.ts,
    # driver-pg-ddl.ts), NOT an advisory lock: that grant belongs to the session, not to the
    # process — it outlives every transaction and no pooled node can renew it or prove it still
    # holds one. A second instance is harmless but idle.
    healthcheck: *metrics-probe
    deploy: { replicas: 1 }

volumes:
  pgdata:
`;

const readme = (app: NameSet): string => `# docker

One image, every role. \`ROLE\` selects behaviour at start, so there is one artifact to promote and
nothing to rebuild between staging and production.

| Role | Does | Listens |
|---|---|---|
| \`web\` | HTTP: pages, actions, assets | \`$PORT\` (default 3000) |
| \`sync\` | websockets for live queries | \`$PORT + 1\` |
| \`worker\` | the job queue | — |
| \`scheduler\` | cron tasks; leadership is an expiring lease row in \`x_scheduler_leader\` | — |
| \`replicator\` | the logical replication slot, exactly one per database | — |
| \`migrate\` | applies pending migrations and **exits** | — |

Every serving role answers \`/healthz\` and \`/readyz\`. \`/readyz\` flips to 503 on \`SIGTERM\` before the
socket closes, which is what makes a rolling restart drain instead of drop.

## Build and run

\`\`\`sh
x build --target docker --tag ${app.kebab}:dev
docker run --rm -e ROLE=migrate -e DATABASE_URL=postgres://... ${app.kebab}:dev
docker run -p 3000:3000 -e DATABASE_URL=postgres://... ${app.kebab}:dev
\`\`\`

## One box, every role

\`\`\`sh
docker compose -f docker/docker-compose.prod.yml up -d      # db → migrate → the rest
x deploy --image ${app.kebab}:dev --dry-run --json           # the same plan, printed
\`\`\`

\`web\` and \`sync\` publish a host port, so both sit at \`replicas: 1\`: one host port has exactly one
binder, and a second container dies on \`port is already allocated\`. \`worker\` publishes nothing and
scales freely. To scale the two serving roles on one box, delete their \`ports:\` lines and put your
own proxy on the compose network. To scale them properly, use an orchestrator — see below.

## The other two build targets

\`\`\`sh
x build --target static --out dist/static   # one HTML file per \`render: 'static'\` route
x build --target binary --out dist/app      # a single executable, no Bun install needed
\`\`\`

The binary bundles the framework, not the app: the registries are filled by scanning
\`apps/*/{site,app,api,shared}\` at boot, so it is a launcher that must be **started from the app
root**, with the source tree beside it. The image is the self-contained artifact.

## A PaaS (Heroku, Render, Fly, Railway, Cloud Run, App Runner…)

The framework ships **no** platform primitives — no buildpack, no \`app.json\`, no \`fly.toml\`, no
adapter. It does not need to: every one of these platforms builds a Dockerfile and every one of
them expects the same three things, which this image already does.

| The platform does | The image does |
|---|---|
| injects \`PORT\` and routes traffic to it | \`apps/web/server.ts\` binds exactly \`$PORT\`, refusing a value that is not a port (\`X_PORT_INVALID\`) rather than defaulting past it |
| requires the process to bind \`0.0.0.0\` | it binds every interface; loopback would be unreachable from outside the container |
| polls a health path | \`/readyz\` for "may I have traffic", \`/healthz\` for "am I alive" |
| sends \`SIGTERM\`, then \`SIGKILL\` after a grace period | drains in three phases: stop accepting, finish in-flight, close |

Set \`DATABASE_URL\` and deploy the Dockerfile. That is the whole integration.

### Release-phase migrations — the one way

Run **the same image** with \`ROLE=migrate\` before the new release serves traffic. It applies every
pending migration in \`packages/db/migrations\` under a Postgres advisory lock, records each in the
\`x_migrations\` ledger with its checksum, and exits 0. Concurrent migrators serialise; a checksum
that no longer matches an applied migration stops the release instead of corrupting it.

| Platform | Where the command goes |
|---|---|
| Heroku | \`release: bun apps/web/server.ts\` in \`Procfile\`, with \`ROLE=migrate\` on the release dyno |
| Render | \`preDeployCommand: ROLE=migrate bun apps/web/server.ts\` |
| Fly.io | \`[deploy] release_command = "bun apps/web/server.ts"\` with \`ROLE=migrate\` |
| Railway | a pre-deploy command running the same |
| Kubernetes | an \`initContainer\` or a \`Job\` on the same image with \`ROLE=migrate\` |
| Compose | the \`migrate\` service; every other role waits on \`service_completed_successfully\` |

There is no \`x db migrate\` in that list on purpose: it is the developer's command and it needs the
toolchain, while the release phase runs the shipped image and nothing else.

### One-off commands need a new entrypoint, not arguments

\`ENTRYPOINT\` is \`bun apps/web/server.ts\`, and that entry reads \`ROLE\` and \`PORT\` and **nothing
else** — argv never reaches a parser. So arguments appended to it are discarded in silence:

\`\`\`sh
docker run ${app.kebab}:dev db backfill --all --write     # serves ROLE=web, forever
docker run --entrypoint bun ${app.kebab}:dev node_modules/@ultimat3/cli/src/bin.ts db backfill --all --write --json
\`\`\`

The \`backfill\` service in \`docker-compose.prod.yml\` is the second form. A Kubernetes \`Job\` running
a one-off command sets \`command:\` (the entrypoint) as well as \`args:\`, for the same reason.

## Environment

| Key | Meaning | Unset means |
|---|---|---|
| \`ROLE\` | which process this is | \`web\` |
| \`PORT\` | the port the web role binds | 3000 |
| \`DATABASE_URL\` | Postgres | embedded PGlite — never in production |
| \`BUILD_ID\` | the immutable build hash clients are served against | computed from the manifest at boot |
| \`NATS_URL\` | multi-node realtime transport | in-process fanout, single node only |
| \`S3_ENDPOINT\` | object storage | a local directory |

## Kubernetes

\`\`\`sh
x deploy --method helm --image ghcr.io/you/${app.kebab}:1.2.3 --dry-run --json   # the plan
x deploy --method helm --image ghcr.io/you/${app.kebab}:1.2.3                    # run it
\`\`\`

One \`helm upgrade --install\` against \`docker/helm\`, which is scaffolded beside this file for the
same reason \`docker-compose.prod.yml\` is: a deploy method whose topology file only exists in
somebody else's repository is a command that cannot run. \`--image\` sets \`image.repository\` and
\`image.tag\`; everything else is \`docker/helm/values.yaml\`, and it is yours to edit.

| Object | Per | Note |
|---|---|---|
| Deployment + Service | enabled role | one image, \`ROLE\` and the port are the only difference |
| Job | release | \`ROLE=migrate\`, a \`pre-install,pre-upgrade\` hook — it runs to completion first |
| Ingress | release | off by default; routes \`/_x/sync\` to sync and \`/\` to web |
| HorizontalPodAutoscaler | role, opt-in | rps, websocket connections, queue depth — never CPU |

No ServiceMonitor and no PodDisruptionBudget: the first needs a CRD \`helm install\` fails on in a
cluster with no Prometheus operator, and both are cluster policy rather than this app's topology.
Every role already answers \`/metrics\` on \`metricsPort\`.
`;

/** The container files for a new app, in the order a reader meets them. */
export function containerFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'docker/Dockerfile', contents: dockerfile(app) },
    { path: 'docker/Dockerfile.dockerignore', contents: dockerignore() },
    { path: 'docker/docker-compose.prod.yml', contents: composeProd(app) },
    { path: 'docker/README.md', contents: readme(app) },
    // The other deploy method's topology, on the same terms as the compose file above: `x deploy`
    // is one `helm upgrade --install` against this directory, and a chart that shipped in no npm
    // tarball made that command's only failure mode "clone the framework repository".
    ...helmFiles(app),
  ];
}
