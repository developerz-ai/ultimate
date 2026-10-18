// The backing services a new app's suites run against: `docker/docker-compose.test.yml` and the
// one env file that points the suites at it. In RAM, durability off, silent — the framework's own
// `docker/docker-compose.test.yml`, cut to what an app has. Ports sit apart from the dev stack's
// so both can run at once; `ci.yml` starts this file before `bun run check`.

import type { GeneratedFile, NameSet } from './naming';

export const TEST_COMPOSE_PATH = 'docker/docker-compose.test.yml';
export const TEST_ENV_PATH = 'docker/test-services.env';

/** Host ports, one place: the compose file publishes them and the env file names them. */
export const TEST_PORTS = { postgres: 55432, redis: 56379, nats: 54222, s3: 59000 } as const;

const composeTest = (
  app: NameSet,
): string => `# The services the test suites run against — in RAM, and silent.
#
#   docker compose -f ${TEST_COMPOSE_PATH} up -d --wait
#   set -a; . ${TEST_ENV_PATH}; set +a
#   bun run check
#
# \`--wait\` returns once every healthcheck passes. CI runs the same lines (.github/workflows/ci.yml).
# None of it is required: with no TEST_* variable set the unit suite runs on the in-memory driver,
# and a suite that needs a real server skips. Ports are the dev stack's plus 50000, so both run.
#
# Three rules, on every service:
#
#   * RAM. Data lives on a tmpfs: no block device written, nothing left behind by \`down\`.
#   * NO DURABILITY. fsync, synchronous_commit and full_page_writes off, WAL minimal and no WAL
#     senders; Redis keeps no RDB snapshot and no AOF. A test database that survives a crash is a
#     database nobody asked for.
#   * SILENT. Each server logs as little as it can be told to, and the log driver is \`none\`. To
#     watch one that will not start, run it attached: \`docker compose -f ${TEST_COMPOSE_PATH} up postgres\`.
#
# Every port binds 127.0.0.1: the credentials are in this file.
name: ${app.kebab}-test

x-silent: &silent
  logging: { driver: none }

services:
  # Postgres 18, the production major. \`initdb -c\` writes each setting into the new cluster;
  # \`--no-sync\` is initdb's own fsync of a cluster on a tmpfs. Postgres 18 images keep the cluster
  # under /var/lib/postgresql/18, so the tmpfs is the parent.
  postgres:
    <<: *silent
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: ${app.kebab}
      POSTGRES_PASSWORD: ${app.kebab}-test
      POSTGRES_DB: postgres
      POSTGRES_INITDB_ARGS: >-
        --no-sync
        -c fsync=off
        -c synchronous_commit=off
        -c full_page_writes=off
        -c wal_level=minimal
        -c max_wal_senders=0
        -c logging_collector=off
        -c log_min_messages=fatal
        -c log_statement=none
        -c log_checkpoints=off
        -c log_connections=off
        -c log_disconnections=off
    tmpfs: [/var/lib/postgresql]
    ports: ['127.0.0.1:${TEST_PORTS.postgres}:5432']
    healthcheck:
      # TCP, never the socket: the entrypoint's temporary init server listens on the socket only.
      test: ['CMD-SHELL', 'pg_isready -U ${app.kebab} -h 127.0.0.1 -p 5432']
      interval: 1s
      timeout: 3s
      retries: 60

  redis:
    <<: *silent
    image: redis:8-alpine
    command: ['redis-server', '--save', '', '--appendonly', 'no', '--loglevel', 'warning']
    tmpfs: [/data]
    ports: ['127.0.0.1:${TEST_PORTS.redis}:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 1s
      timeout: 3s
      retries: 30

  # JetStream's store on the tmpfs; \`-l /dev/null\` is the only quiet a nats-server has.
  nats:
    <<: *silent
    image: nats:2-alpine
    command: ['-js', '-sd', '/data', '-m', '8222', '-l', '/dev/null']
    tmpfs: [/data]
    ports: ['127.0.0.1:${TEST_PORTS.nats}:4222']
    healthcheck:
      test: ['CMD', 'wget', '-q', '--spider', 'http://127.0.0.1:8222/healthz']
      interval: 1s
      timeout: 3s
      retries: 30

  # A directory under /data is a bucket, so the tmpfs mounted AT the bucket's path is the bootstrap.
  s3:
    <<: *silent
    image: versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499
    environment:
      VGW_BACKEND: posix
      VGW_BACKEND_ARG: /data
      VGW_PORT: ':9000'
      VGW_QUIET: 'true'
      VGW_REGION: auto
      ROOT_ACCESS_KEY: ${app.kebab}
      ROOT_SECRET_KEY: ${app.kebab}-test
    tmpfs: [/data/${app.kebab}-test]
    ports: ['127.0.0.1:${TEST_PORTS.s3}:9000']
    healthcheck:
      test: ['CMD', 'nc', '-z', '127.0.0.1', '9000']
      interval: 1s
      timeout: 3s
      retries: 30
`;

const testEnv = (
  app: NameSet,
): string => `# Where the suites find the services ${TEST_COMPOSE_PATH} starts — the one place these URLs are
# written. A laptop sources it (\`set -a; . ${TEST_ENV_PATH}; set +a\`); CI appends it to $GITHUB_ENV.
# TEST_DATABASE_URL is what @ultimat3/testing clones one database per test worker from.
TEST_DATABASE_URL=postgres://${app.kebab}:${app.kebab}-test@127.0.0.1:${TEST_PORTS.postgres}/postgres
TEST_REDIS_URL=redis://127.0.0.1:${TEST_PORTS.redis}
TEST_NATS_URL=nats://127.0.0.1:${TEST_PORTS.nats}
TEST_S3_URL=http://${app.kebab}:${app.kebab}-test@127.0.0.1:${TEST_PORTS.s3}/${app.kebab}-test
`;

/** The test stack and its env file. */
export function testServicesFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: TEST_COMPOSE_PATH, contents: composeTest(app) },
    { path: TEST_ENV_PATH, contents: testEnv(app) },
  ];
}
