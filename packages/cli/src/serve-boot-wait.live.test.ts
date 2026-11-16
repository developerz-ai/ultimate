// The deploy order no hook enforces, as real processes: a web role started BEFORE its migrate step
// waits (its own port alive and not ready, its gauge scraped as unapplied) and serves the moment
// `ROLE=migrate` lands; SIGTERM mid-wait is a drain that exits 0, never a crash.
//
// Skips unless `TEST_DATABASE_URL` is set: it creates and drops its own database on that server.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { METRICS_PATH, probeDatabaseName } from '@ultimat3/core';
import { allowHost, bindFreePorts } from '@ultimat3/testing';
import { planNewApp } from './cmd-new';
import { SCHEMA_WAIT_ENV } from './framework-schema-wait';
import { processRoot } from './process-root-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
const DB = probeDatabaseName('x_schema_wait_probe');
const TIMEOUT_MS = 120_000;
const ROOT = processRoot(join(import.meta.dir, '..', '.schema-wait-fixture'));

const dbUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://unset');
  parsed.pathname = `/${DB}`;
  return parsed.href;
};

async function admin(statement: string): Promise<void> {
  const sql = new Bun.SQL(url ?? '', { max: 1 });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end();
  }
}

async function writeFixture(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  const server = planNewApp({ name: 'schema-wait', example: false }).find(
    (file) => file.path === 'apps/web/server.ts',
  );
  if (server === undefined || typeof server.contents !== 'string') {
    return expect.unreachable('x new writes apps/web/server.ts as text');
  }
  await Bun.write(join(ROOT, 'apps/web/server.ts'), server.contents);
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'schema-wait', version: '1.0.0' }),
  );
  await Bun.write(
    join(ROOT, 'app.config.ts'),
    "import { defineConfig } from '@ultimat3/core';\n" +
      "export const config = defineConfig({ name: 'schema-wait' });\n",
  );
}

/** The child's output on both streams, accumulated; the answer resolves once it holds `marker`. */
function watch(...streams: ReadableStream<Uint8Array>[]) {
  let seen = '';
  const woken: (() => void)[] = [];
  const read = streams.map((stream) => {
    const decoder = new TextDecoder();
    return (async () => {
      for await (const chunk of stream) {
        seen += decoder.decode(chunk, { stream: true });
        for (const wake of woken.splice(0)) wake();
      }
    })();
  });
  const until = async (marker: string): Promise<string> => {
    while (!seen.includes(marker)) await new Promise<void>((resolve) => woken.push(resolve));
    return seen;
  };
  /** Everything the child wrote, once both streams have ended. */
  const all = async (): Promise<string> => {
    await Promise.all(read);
    return seen;
  };
  return Object.assign(until, { all });
}

/**
 * A serving role spawned before its migrate step, resolved once it says it waits — its port and its
 * scrape port bound by then. One that exits first, meeting a port another process took after it
 * was handed out, is spawned again on fresh ones (`bindFreePorts`); any other exit is the failure.
 */
const waiting = (role: string) =>
  bindFreePorts(
    async ([app = 0, metrics = 0]) => {
      const child = spawnRole(role, { app, metrics });
      const until = watch(child.stdout, child.stderr);
      const outcome = await Promise.race([
        until('ultimate schema waiting').then(() => 'waiting' as const),
        child.exited.then(() => 'exited' as const),
      ]);
      if (outcome === 'exited') {
        return expect.unreachable(`ROLE=${role} exited before it waited: ${await until.all()}`);
      }
      return { child, until, ports: { app, metrics } };
    },
    { count: 2 },
  );

/** `ROLE=migrate` binds nothing — it applies the ledger and exits — so its ports are never asked. */
const MIGRATE_PORTS = { app: 0, metrics: 0 };

function spawnRole(role: string, ports: { app: number; metrics: number }) {
  return Bun.spawn(['bun', join(ROOT, 'apps/web/server.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ROLE: role,
      PORT: String(ports.app),
      METRICS_PORT: String(ports.metrics),
      DATABASE_URL: dbUrl(),
      ULTIMATE_STATE_DIR: join(ROOT, '.x'),
      [SCHEMA_WAIT_ENV]: '90000',
      LOG_LEVEL: 'info',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describeLive('live · a role started before its migrate step', () => {
  test(
    'waits alive and not ready, scraped as unapplied, then serves once ROLE=migrate lands',
    async () => {
      await writeFixture();
      await admin(`drop database if exists ${DB} with (force)`);
      await admin(`create database ${DB}`);
      const { child: web, until, ports } = await waiting('web');
      try {
        allowHost(`127.0.0.1:${String(ports.app)}`);
        allowHost(`127.0.0.1:${String(ports.metrics)}`);
        const app = `http://127.0.0.1:${String(ports.app)}`;
        expect((await fetch(`${app}/healthz`)).status).toBe(200);
        expect((await fetch(`${app}/readyz`)).status).toBe(503);
        const scrape = await (
          await fetch(`http://127.0.0.1:${String(ports.metrics)}${METRICS_PATH}`)
        ).text();
        expect(scrape).toContain('\nframework_schema_applied 0\n');

        const migrate = spawnRole('migrate', MIGRATE_PORTS);
        const migrated = watch(migrate.stdout, migrate.stderr);
        expect(await migrate.exited).toBe(0);
        await migrated('ultimate migrate applied');
        await until('ultimate started');
        expect((await fetch(`${app}/readyz`)).status).toBe(200);

        web.kill('SIGTERM');
        expect(await web.exited).toBe(0);
      } finally {
        web.kill('SIGKILL');
        await web.exited;
        await admin(`drop database if exists ${DB} with (force)`);
      }
    },
    TIMEOUT_MS,
  );

  test(
    'SIGTERM mid-wait drains and exits 0 — a rollout superseding a waiting pod is not a crash',
    async () => {
      await writeFixture();
      await admin(`drop database if exists ${DB} with (force)`);
      await admin(`create database ${DB}`);
      const { child: web } = await waiting('worker');
      try {
        web.kill('SIGTERM');
        expect(await web.exited).toBe(0);
      } finally {
        web.kill('SIGKILL');
        await web.exited;
        await admin(`drop database if exists ${DB} with (force)`);
      }
    },
    TIMEOUT_MS,
  );

  test(
    'SIGUSR2 mid-wait (the preStop retire) drains and exits 0 now, never at the deadline',
    async () => {
      await writeFixture();
      await admin(`drop database if exists ${DB} with (force)`);
      await admin(`create database ${DB}`);
      const { child: worker } = await waiting('worker');
      try {
        const sentAt = performance.now();
        worker.kill('SIGUSR2');
        expect(await worker.exited).toBe(0);
        // The wait's deadline is 90s (`spawnRole`): exiting long before it is the retire's doing.
        expect(performance.now() - sentAt).toBeLessThan(30_000);
      } finally {
        worker.kill('SIGKILL');
        await worker.exited;
        await admin(`drop database if exists ${DB} with (force)`);
      }
    },
    TIMEOUT_MS,
  );
});
