// The production topology `x new` writes: one compose service per role, one image. Split from
// scaffold-container.ts, which holds the image and the page that explains it; this file is what
// `x deploy --method compose` runs, and the single-node rung of the scale ladder.

import type { NameSet } from './naming';

/**
 * The production env file, relative to the app root. Named once because two readers must agree:
 * the compose file's \`env_file:\` (what the containers see) and \`x deploy\`'s \`--env-file\` (what
 * compose interpolates \`\${VAR:?…}\` from). Two spellings would let them drift apart silently.
 */
export const PROD_ENV_FILE = '.env.production';

/** The production topology `x new` writes at `docker/docker-compose.prod.yml`. */
export const composeProdFile = (
  app: NameSet,
): string => `# The production topology: one service per role, one image, differing only by ROLE and replicas.
# What \`x deploy --method compose\` runs. migrate runs to completion before anything serves.
#
#   IMAGE=ghcr.io/you/${app.kebab}:1.2.3 x deploy --image ghcr.io/you/${app.kebab}:1.2.3
#
# By hand, always with \`--env-file ${PROD_ENV_FILE}\`: Compose fills \`\${VAR:?…}\` below from the shell
# and \`--env-file\` only, NEVER from \`env_file:\`, so without it a value set only in that file is
# "missing" and the parse fails. \`x deploy\` passes it on every step.
#
#   docker compose --env-file ${PROD_ENV_FILE} -f docker/docker-compose.prod.yml up -d
#
# A published host port has exactly one binder, so \`web\` and \`sync\` run at 1 here. Compose is one
# box; horizontal scaling of those two belongs to an orchestrator — \`docker/helm\`, beside this
# file, is the chart \`x deploy --method helm\` installs. To scale them on one box anyway, drop
# \`ports:\` and put your own proxy on this network — the service name resolves to every replica
# over the compose DNS round robin.
name: ${app.kebab}

# Every service's logs, rotated. Docker's default json-file driver never rotates, so a chatty role
# on a long-lived box fills the disk the database lives on; 3 x 10 MB per container is the ceiling.
x-logging: &logging
  driver: json-file
  options: { max-size: 10m, max-file: '3' }

x-image: &image
  image: \${IMAGE:-${app.kebab}:dev}
  env_file: [../${PROD_ENV_FILE}]
  restart: unless-stopped
  logging: *logging
  # SIGTERM → /readyz answers 503 for the readiness grace (5s outside local environments), then the
  # drain of in-flight requests, jobs and sockets (25s). 40s leaves 10s before Docker SIGKILLs.
  stop_grace_period: 40s
  # What the chart's securityContext applies, on the rung that had none: a read-only root
  # filesystem, no Linux capabilities (nothing here binds below 1024), no setuid escalation, and a
  # memory ceiling so one runaway role takes down its container rather than the box. /tmp and .x/
  # are tmpfs — .x/ is where a still-embedded binding keeps state, which production never relies on.
  read_only: true
  tmpfs: [/tmp, /app/.x]
  cap_drop: [ALL]
  security_opt: ['no-new-privileges:true']
  mem_limit: 1g
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
    logging: *logging

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
    # The page dials SYNC_URL; unset, it dials /_x/sync on :3000, which web does not serve here.
    # Set it in ${PROD_ENV_FILE}: \`--env-file\` (header) is what lets this line read it there.
    environment: [ROLE=web, 'SYNC_URL=\${SYNC_URL:?set SYNC_URL=ws://<host>:3001/_x/sync, see wiki/Deployment.md}']
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
    # OFF by default (zero replicas). A sync node on this database hears committed changes only
    # from a replicator it can reach, and this file runs none: booted anyway it is refused
    # (X_REALTIME_TOPOLOGY). To turn live queries and channels on: declare realtime: { enabled:
    # true, transport: 'nats', urlEnv: 'NATS_URL' } in app.config.ts, add a NATS service and set the
    # SAME NATS_URL for web, sync and a replicator service (ROLE=replicator, exactly one), start
    # Postgres with wal_level=logical and a REPLICATION role on a cluster dedicated to this app (the replicator creates its publication at boot), then set replicas: 1.
    # A NATS_URL under transport 'memory' refuses the boot (X_CONFIG_INVALID), and so does 'nats'
    # without one.
    deploy: { replicas: 0 } # when on: scales on concurrent websockets — pinned to 1 by the port
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
    # Fixed 1. Leadership is an EXPIRING LEASE ROW in \`x_scheduler_leader\` (role-start.ts,
    # driver-pg-ddl.ts), NOT an advisory lock: that grant belongs to the session, not to the
    # process — it outlives every transaction and no pooled node can renew it or prove it still
    # holds one. A second instance is harmless but idle.
    healthcheck: *metrics-probe
    deploy: { replicas: 1 }

volumes:
  pgdata:
`;
