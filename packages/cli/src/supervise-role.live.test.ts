// The framework's real `web` role under the supervisor, as a production container runs it: the
// scaffold's own `apps/web/server.ts`, `ULTIMATE_ENV=production`, `ULTIMATE_PROCESSES=2`, a real
// Postgres and NATS (the shared state an explicit count requires). Two children serve one port, the
// supervisor answers the container's probes, each child holds its share of the pool, SIGTERM drains
// both to 0. Linux only; skips without `TEST_DATABASE_URL` and `TEST_NATS_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { allowHost, bindFreePorts } from '@ultimat3/testing';
import { planNewApp } from './cmd-new';
import { processRoot } from './process-root-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const nats = Bun.env['TEST_NATS_URL'];
const runs =
  process.platform === 'linux' &&
  typeof url === 'string' &&
  url.length > 0 &&
  typeof nats === 'string' &&
  nats.length > 0;
const PROBE_DB = probeDatabaseName('x_supervise_role_live');
const ROOT = processRoot(join(import.meta.dir, '..', '.supervise-role-fixture'));
/** Migrate, then two children each booting the services and the role: seconds of real work each. */
const TIMEOUT_MS = 120_000;
/** The container's pool, split 3 + 3 across the two children. */
const POOL = 6;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** A production deploy's environment: no development default survives it. */
const production = (extra: Record<string, string>): Record<string, string | undefined> => ({
  ...process.env,
  ULTIMATE_ENV: 'production',
  NODE_ENV: 'production',
  ULTIMATE_CURSOR_SECRET: 'supervise-role-live-cursor-secret-0123456789abcdef',
  // The embedded disk on a volume the children share, signed with a key of the deploy's own.
  STORAGE_SIGNING_SECRET: 'supervise-role-live-storage-secret-0123456789abcdef',
  DATABASE_URL: probeUrl(),
  NATS_URL: nats ?? '',
  HOST: '127.0.0.1',
  ...extra,
});

function scaffolded(path: string): string {
  const file = planNewApp({ name: 'supervise-role', example: false }).find(
    (candidate) => candidate.path === path,
  );
  if (file === undefined) return expect.unreachable(`x new writes no ${path}`);
  return typeof file.contents === 'string'
    ? file.contents
    : expect.unreachable(`${path} is bytes, not text`);
}

/** Both streams of a child, read once each; `seen()` is everything so far. */
function collect(child: {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}) {
  let seen = '';
  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) seen += decoder.decode(chunk, { stream: true });
  };
  const ended = Promise.all([read(child.stdout), read(child.stderr)]);
  return { seen: () => seen, ended };
}

/** Polls `target` until it answers `status`; the test's timeout is the bound. */
async function until(target: string, status: number, gone: Promise<number>): Promise<void> {
  let exited: number | undefined;
  void gone.then((code) => {
    exited = code;
  });
  for (;;) {
    if (exited !== undefined) expect.unreachable(`the supervisor exited ${String(exited)}`);
    const answered = await fetch(target).then(
      (response) => response.status,
      () => 0,
    );
    if (answered === status) return;
    // real-clock: another process's readiness, asked over its socket; it has no event to await.
    await Bun.sleep(100);
  }
}

/** The value of `name{…child="<index>"…}` in a merged scrape, every sample of it summed. */
const sampleSum = (scrape: string, name: string, index: string): number =>
  scrape
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`) && line.includes(`child="${index}"`))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);

describe.skipIf(!runs)('live · the web role under the supervisor, as production runs it', () => {
  let admin: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'supervise-role', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'supervise-role' });\n",
    );
    await Bun.write(join(ROOT, 'apps/web/server.ts'), scaffolded('apps/web/server.ts'));
    // The release phase first: a serving role on a real database verifies, never applies.
    const migrate = Bun.spawn(['bun', join(ROOT, 'apps/web/server.ts')], {
      cwd: ROOT,
      env: production({ ROLE: 'migrate' }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const logs = collect(migrate);
    const code = await migrate.exited;
    await logs.ended;
    if (code !== 0) expect.unreachable(`ROLE=migrate exited ${String(code)}: ${logs.seen()}`);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await admin?.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin?.close();
  });

  test(
    'two children serve one port, the supervisor probes and merges them, SIGTERM drains both to 0',
    async () => {
      const booted = await bindFreePorts(
        async ([port = 0, metricsPort = 0]) => {
          allowHost(`127.0.0.1:${String(port)}`);
          allowHost(`127.0.0.1:${String(metricsPort)}`);
          const proc = Bun.spawn(['bun', join(ROOT, 'apps/web/server.ts')], {
            cwd: ROOT,
            env: production({
              ROLE: 'web',
              PORT: String(port),
              METRICS_PORT: String(metricsPort),
              ULTIMATE_PROCESSES: '2',
              DATABASE_POOL_MAX: String(POOL),
            }),
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const logs = collect(proc);
          await until(`http://127.0.0.1:${String(metricsPort)}/readyz`, 200, proc.exited).catch(
            async (error: unknown) => {
              proc.kill('SIGKILL');
              await logs.ended;
              return expect.unreachable(`${String(error)}; the container said: ${logs.seen()}`);
            },
          );
          return { proc, logs, port, metricsPort };
        },
        { count: 2 },
      );
      const { proc, logs, port, metricsPort } = booted;
      try {
        // Fresh connections: keep-alive would pin every request to whichever child took the first.
        // A path no route owns, because the probes are not counted and this 404 is, per child.
        for (let request = 0; request < 40; request += 1) {
          const answer = await fetch(`http://127.0.0.1:${String(port)}/no-such-page`, {
            headers: { connection: 'close' },
          });
          expect(answer.status).toBe(404);
          await answer.arrayBuffer();
        }
        expect((await fetch(`http://127.0.0.1:${String(metricsPort)}/readyz`)).status).toBe(200);

        // Each child counted the requests IT served: the merged scrape tells them apart by label.
        const scrape = await (
          await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
        ).text();
        const served0 = sampleSum(scrape, 'http_requests_total', '0');
        const served1 = sampleSum(scrape, 'http_requests_total', '1');
        expect(served0).toBeGreaterThan(0);
        expect(served1).toBeGreaterThan(0);
        // Each child's pool is its share: the container's connections do not grow with N.
        expect(sampleSum(scrape, 'db_pool_max', '0')).toBe(POOL / 2);
        expect(sampleSum(scrape, 'db_pool_max', '1')).toBe(POOL / 2);

        const decided = logs
          .seen()
          .split('\n')
          .find((line) => line.includes('"msg":"ultimate processes"'));
        expect(decided).toContain('"count":2');
        expect(decided).toContain('"binding":"requested"');

        proc.kill('SIGTERM');
        expect(await proc.exited).toBe(0);
        await logs.ended;
        // Both children drained — core's last line, once per child — and the supervisor said so.
        const stopped = logs
          .seen()
          .split('\n')
          .filter((line) => line.includes('"msg":"stopped"'));
        expect(stopped.some((line) => line.includes('"child":0'))).toBe(true);
        expect(stopped.some((line) => line.includes('"child":1'))).toBe(true);
        expect(logs.seen()).toContain('"msg":"ultimate processes stopped"');
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    },
    TIMEOUT_MS,
  );
});
