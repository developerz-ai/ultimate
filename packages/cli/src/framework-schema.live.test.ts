// The boot DDL against a real server, with a second session holding a transaction open on `x_jobs`
// (plan 101, s1-con #5). Before: every role boot ran `alter table … add column if not exists`
// (ACCESS EXCLUSIVE) with `lock_timeout` 0, queued behind that transaction, and every enqueue in
// the fleet queued behind the boot. Now `ROLE=migrate` applies under the migration lock with a
// bounded `lock_timeout`, and a serving role runs no DDL at all.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`: this file creates and drops a
// database.
//
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@localhost:5432/postgres \
//     bun test packages/cli/src/framework-schema.live.test.ts

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { resetLifecycle } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { createPostgresClient, raw } from '@ultimat3/db';
import { applyFrameworkSchema } from './framework-schema';
import { applyLockedSchema, verifySchema } from './framework-schema-apply';
import { serveApp } from './serve';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
const PROBE_DB = 'x_framework_schema_probe';
const TIMEOUT_MS = 60_000;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://unset');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const on = async (target: string, statement: string): Promise<void> => {
  const sql = new Bun.SQL(target, { max: 1 });
  try {
    await sql.unsafe(statement, []);
  } finally {
    await sql.end();
  }
};

let client: PostgresClient | undefined;

beforeEach(async () => {
  await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
  await on(url ?? '', `create database ${PROBE_DB}`);
  client = createPostgresClient({ url: probeUrl() });
}, TIMEOUT_MS);

afterEach(async () => {
  await client?.close();
  client = undefined;
}, TIMEOUT_MS);

afterAll(async () => {
  if (url !== undefined) await on(url, `drop database if exists ${PROBE_DB} with (force)`);
  resetLifecycle();
}, TIMEOUT_MS);

/** A second session with a transaction open that has read `x_jobs` — ACCESS SHARE, held. */
async function holdOpenTransaction(): Promise<() => Promise<void>> {
  const holder = new Bun.SQL(probeUrl(), { max: 1 });
  const reserved = await holder.reserve();
  await reserved.unsafe('begin', []);
  await reserved.unsafe('select count(*) from x_jobs', []);
  return async () => {
    await reserved.unsafe('rollback', []);
    reserved.release();
    await holder.end();
  };
}

const elapsed = async (run: () => Promise<unknown>): Promise<{ ms: number; error: unknown }> => {
  const started = performance.now();
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return { ms: performance.now() - started, error };
};

describeLive('live · the framework schema beside an open transaction', () => {
  test(
    'apply gives up within its lock_timeout instead of queueing behind the transaction',
    async () => {
      const db = client as PostgresClient;
      await applyLockedSchema(db);
      const release = await holdOpenTransaction();
      try {
        const { ms, error } = await elapsed(() => applyLockedSchema(db));
        expect((error as { code?: string } | undefined)?.code).toBe('X_FRAMEWORK_SCHEMA_FAILED');
        // The lock wait, not the role's statement_timeout (10 s) — the unbounded wait ended there.
        expect((error as { cause?: string }).cause).toContain('X_DB_LOCK_TIMEOUT');
        // 3 s is the migrate pool's lock_timeout; unbounded, this waited for the transaction.
        expect(ms).toBeLessThan(8_000);
      } finally {
        await release();
      }
    },
    TIMEOUT_MS,
  );

  test(
    'verify runs no DDL, so it is not queued behind the transaction at all',
    async () => {
      const db = client as PostgresClient;
      await applyLockedSchema(db);
      const release = await holdOpenTransaction();
      try {
        const { ms, error } = await elapsed(() => verifySchema(db));
        expect(error).toBeUndefined();
        expect(ms).toBeLessThan(2_000);
      } finally {
        await release();
      }
    },
    TIMEOUT_MS,
  );

  test(
    'two migrators racing a fresh database both succeed — the lock serialises the create tables',
    async () => {
      const second = createPostgresClient({ url: probeUrl() });
      try {
        const results = await Promise.allSettled([
          applyLockedSchema(client as PostgresClient),
          applyLockedSchema(second),
        ]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      } finally {
        await second.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    'a database whose tables exist but carry no stamp of this build is refused',
    async () => {
      const db = client as PostgresClient;
      await applyFrameworkSchema((statement) => db.execute(raw(statement)));
      await expect(verifySchema(db)).rejects.toMatchObject({
        code: 'X_FRAMEWORK_SCHEMA_UNAPPLIED',
      });
      await applyLockedSchema(db);
      await verifySchema(db);
    },
    TIMEOUT_MS,
  );

  test(
    'a serving role on an external database refuses before its migrate ran, and runs no DDL',
    async () => {
      const root = `${import.meta.dir}/../.framework-schema-live-fixture`;
      await Bun.write(
        `${root}/package.json`,
        JSON.stringify({ name: 'fs-live', version: '1.0.0' }),
      );
      await Bun.write(
        `${root}/app.config.ts`,
        "import { defineConfig } from '@ultimat3/core';\nexport const config = defineConfig({ name: 'fs-live' });\n",
      );
      try {
        const outcome = await serveApp({
          root,
          env: { NODE_ENV: 'test', DATABASE_URL: probeUrl(), ULTIMATE_STATE_DIR: `${root}/.x` },
          role: 'worker',
          port: 0,
          metricsPort: 0,
        }).then(
          async (app) => {
            await app.stop();
            return 'booted';
          },
          (error: unknown) => (error as { code?: string }).code ?? 'uncoded',
        );
        expect(outcome).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
        const rows = await (client as PostgresClient).query<{ readonly n: number }>(
          raw("select count(*)::int as n from pg_tables where tablename = 'x_jobs'"),
        );
        expect(rows[0]?.n).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
