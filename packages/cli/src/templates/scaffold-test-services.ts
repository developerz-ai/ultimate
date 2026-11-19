// The backing services a new app's suites run against: `docker/docker-compose.test.yml` and the
// one env file that points the suites at it. In RAM, durability off, silent — the framework's own
// `docker/docker-compose.test.yml`, cut to what an app has. Ports sit apart from the dev stack's
// so both can run at once; `ci.yml` starts this file before `bun run verify`.

import { fnv1a } from '@ultimat3/core';
import type { GeneratedFile, NameSet } from './naming';
import { S3_GATEWAY_IMAGE } from './pinned-images';

export const TEST_COMPOSE_PATH = 'docker/docker-compose.test.yml';
export const TEST_ENV_PATH = 'docker/test-services.env';

/** Each service's band start: the dev stack's port plus 50000, so both stacks run at once. */
export const TEST_PORTS = { postgres: 55432, redis: 56379, nats: 54222, s3: 59000 } as const;

/** How wide each band is: the bands stay disjoint, and two apps collide 1 time in 500. */
export const TEST_PORT_SPREAD = 500;

type TestPorts = { readonly [K in keyof typeof TEST_PORTS]: number };

/** The app's name, and the checkout's root when the scaffold knows it: what keys its own stack. */
const stackKey = (app: NameSet, root: string | undefined): string =>
  root === undefined ? app.kebab : `${app.kebab}\0${root}`;

/**
 * This app's host ports, one place: the compose file publishes them and the env file names them.
 * One fixed set made two scaffolds on one machine share 55432, so the second app's live suites
 * dialled the first app's container; the app's name — and its root, when the scaffold knows it, so
 * two scaffolds of one name differ too — picks its offset into each band.
 */
export const testPorts = (app: NameSet, root?: string): TestPorts => {
  // FNV-1a: stable across machines and runs.
  const offset = fnv1a(stackKey(app, root)) % TEST_PORT_SPREAD;
  return {
    postgres: TEST_PORTS.postgres + offset,
    redis: TEST_PORTS.redis + offset,
    nats: TEST_PORTS.nats + offset,
    s3: TEST_PORTS.s3 + offset,
  };
};

/**
 * The compose project, written into the file as its `name:` — so every reader (`x verify`,
 * `x clean --services`, CI, a hand-typed `docker compose -f`) resolves the same one, and a name
 * an app wrote itself is never second-guessed. `<app>-test` alone made every scaffold of one name
 * on one machine one project; with the root, each scaffold's is its own (clones of it share it).
 */
export const testProjectName = (app: NameSet, root?: string): string =>
  root === undefined
    ? `${app.kebab}-test`
    : `${app.kebab}-test-${fnv1a(root).toString(16).padStart(8, '0')}`;

const composeTest = (
  app: NameSet,
  root: string | undefined,
  ports: TestPorts = testPorts(app, root),
): string => `# The services the test suites run against — in RAM, and silent.
#
#   docker compose -f ${TEST_COMPOSE_PATH} up -d --wait
#   set -a; . ${TEST_ENV_PATH}; set +a
#   bun run verify
#
# \`--wait\` returns once every healthcheck passes. CI runs the same lines (.github/workflows/ci.yml).
# None of it is required: with no TEST_* variable set the unit suite runs on the in-memory driver,
# and a suite that needs a real server skips. Ports are this app's own (its name picks
# them), above the dev stack's, so both stacks — and two apps — run at once.
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
name: ${testProjectName(app, root)}

x-silent: &silent
  logging: { driver: none }

services:
  # Postgres 18, the production major. \`initdb -c\` writes each setting into the new cluster;
  # \`--no-sync\` is initdb's own fsync of a cluster on a tmpfs. Postgres 18 images keep the cluster
  # under /var/lib/postgresql/18, so the tmpfs is the parent. After the logging: no JIT and no
  # autovacuum for millisecond queries, room for every parallel test process, and a small WAL —
  # it is RAM here.
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
        -c jit=off
        -c autovacuum=off
        -c max_connections=400
        -c min_wal_size=32MB
        -c max_wal_size=256MB
    tmpfs: [/var/lib/postgresql]
    ports: ['127.0.0.1:${ports.postgres}:5432']
    healthcheck:
      # TCP, never the socket: the entrypoint's temporary init server listens on the socket only.
      test: ['CMD-SHELL', 'pg_isready -U ${app.kebab} -h 127.0.0.1 -p 5432']
      interval: 1s
      timeout: 3s
      retries: 60

  redis:
    <<: *silent
    image: redis:8-alpine
    command: ['redis-server', '--save', '', '--appendonly', 'no', '--loglevel', 'nothing']
    tmpfs: [/data]
    ports: ['127.0.0.1:${ports.redis}:6379']
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
    ports: ['127.0.0.1:${ports.nats}:4222']
    healthcheck:
      test: ['CMD', 'wget', '-q', '--spider', 'http://127.0.0.1:8222/healthz']
      interval: 1s
      timeout: 3s
      retries: 30

  # A directory under /data is a bucket, so the tmpfs mounted AT the bucket's path is the bootstrap.
  s3:
    <<: *silent
    image: ${S3_GATEWAY_IMAGE}
    environment:
      VGW_BACKEND: posix
      VGW_BACKEND_ARG: /data
      VGW_PORT: ':9000'
      VGW_QUIET: 'true'
      VGW_REGION: auto
      ROOT_ACCESS_KEY: ${app.kebab}
      ROOT_SECRET_KEY: ${app.kebab}-test
    tmpfs: [/data/${app.kebab}-test]
    ports: ['127.0.0.1:${ports.s3}:9000']
    healthcheck:
      test: ['CMD', 'nc', '-z', '127.0.0.1', '9000']
      interval: 1s
      timeout: 3s
      retries: 30
`;

const testEnv = (
  app: NameSet,
  root: string | undefined,
  ports: TestPorts = testPorts(app, root),
): string => `# Where the suites find the services ${TEST_COMPOSE_PATH} starts — the one place these URLs are
# written. A laptop sources it (\`set -a; . ${TEST_ENV_PATH}; set +a\`); CI appends it to $GITHUB_ENV.
# TEST_DATABASE_URL is what @ultimat3/testing clones one database per test worker from.
TEST_DATABASE_URL=postgres://${app.kebab}:${app.kebab}-test@127.0.0.1:${ports.postgres}/postgres
TEST_REDIS_URL=redis://127.0.0.1:${ports.redis}
TEST_NATS_URL=nats://127.0.0.1:${ports.nats}
TEST_S3_URL=http://${app.kebab}:${app.kebab}-test@127.0.0.1:${ports.s3}/${app.kebab}-test
`;

/**
 * The test stack and its env file. `root`, the absolute directory `x new` writes into, makes the
 * project name and ports this scaffold's own; without it the bytes are the name-only ones every
 * earlier scaffold wrote, which the codemods compare against.
 */
export function testServicesFiles(app: NameSet, root?: string): readonly GeneratedFile[] {
  return [
    { path: TEST_COMPOSE_PATH, contents: composeTest(app, root) },
    { path: TEST_ENV_PATH, contents: testEnv(app, root) },
  ];
}
