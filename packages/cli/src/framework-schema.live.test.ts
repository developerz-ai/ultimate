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
import { probeDatabaseName, resetLifecycle, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { REQUIRED_BUN } from './app-root';
import { listBackfills } from './db-backfill';
import { applyFrameworkSchema } from './framework-schema';
import { applyLockedSchema, verifySchema } from './framework-schema-apply';
import { withJobDriver } from './jobs-driver';
import { serveApp } from './serve';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
const PROBE_DB = probeDatabaseName('x_framework_schema_probe');
const TIMEOUT_MS = 60_000;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://unset');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const on = async <R = unknown>(
  target: string,
  statement: string,
  values: readonly unknown[] = [],
): Promise<readonly R[]> => {
  const sql = new Bun.SQL(target, { max: 1 });
  try {
    return [...(await sql.unsafe(statement, [...values]))] as R[];
  } finally {
    await sql.end();
  }
};

/** The server-level connection as an executor, for `sweepProbeDatabases`. */
const adminExecutor = {
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    on<R>(url ?? '', text, values),
};

/**
 * A login role with DML only — what a production app's runtime `DATABASE_URL` names: it owns no
 * framework table and holds no `create` on `public`. Cluster-wide, so per run and dropped after.
 */
const DML_ROLE = `${PROBE_DB}_dml`;

const dmlUrl = (): string => {
  const parsed = new URL(probeUrl());
  parsed.username = DML_ROLE;
  parsed.password = 'dml';
  return parsed.href;
};

async function createDmlRole(): Promise<void> {
  await on(url ?? '', `create role ${DML_ROLE} login password 'dml'`);
  // `public` grants create to PUBLIC on a server older than 15; this role must not have it there.
  await on(probeUrl(), 'revoke create on schema public from public');
  await on(probeUrl(), `grant usage on schema public to ${DML_ROLE}`);
  await on(
    probeUrl(),
    `grant select, insert, update, delete on all tables in schema public to ${DML_ROLE}`,
  );
  await on(probeUrl(), `grant usage, select on all sequences in schema public to ${DML_ROLE}`);
}

/** The minimal app root `resolveServices` reads, written beside this file and removed after. */
async function withFixtureApp<R>(name: string, run: (root: string) => Promise<R>): Promise<R> {
  const root = `${import.meta.dir}/../.${name}-fixture`;
  await Bun.write(`${root}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
  await Bun.write(
    `${root}/app.config.ts`,
    `import { defineConfig } from '@ultimat3/core';\nexport const config = defineConfig({ name: '${name}' });\n`,
  );
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** `x db backfill`'s and `x jobs`' own boot, as the runtime role: the driver it hands back. */
const bootAsDmlRole = (root: string): Promise<unknown> =>
  withJobDriver(
    root,
    {
      args: {
        command: 'db',
        subcommand: 'backfill',
        positionals: [],
        flags: new Map(),
        json: true,
        help: false,
        passthrough: [],
      },
      cwd: root,
      runner: () =>
        Promise.resolve({
          command: ['true'],
          code: 0,
          ok: true,
          stdout: '',
          stderr: '',
          durationMs: 0,
        }),
      env: { NODE_ENV: 'test', DATABASE_URL: dmlUrl(), ULTIMATE_STATE_DIR: `${root}/.x` },
      bunVersion: REQUIRED_BUN,
    },
    async (driver) => {
      // `x db backfill --list`'s read through the booted driver: the role uses what it was handed.
      await listBackfills(driver);
      return { ok: true, command: 'db', summary: 'booted' };
    },
  );

let client: PostgresClient | undefined;

beforeEach(async () => {
  await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
  await sweepProbeDatabases(adminExecutor, PROBE_DB);
  // After the database: every grant the role held was inside it, so nothing else depends on it.
  await on(url ?? '', `drop role if exists ${DML_ROLE}`);
  await on(url ?? '', `create database ${PROBE_DB}`);
  client = postgresClient({ url: probeUrl() });
}, TIMEOUT_MS);

afterEach(async () => {
  await client?.close();
  client = undefined;
}, TIMEOUT_MS);

afterAll(async () => {
  if (url !== undefined) await on(url, `drop database if exists ${PROBE_DB} with (force)`);
  if (url !== undefined) await on(url, `drop role if exists ${DML_ROLE}`);
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
      const second = postgresClient({ url: probeUrl() });
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

  test(
    'x db backfill as a DML-only role over a database its owner migrated boots and runs no DDL',
    async () => {
      // Production's split: `ROLE=migrate` as the owner, then the PostSync backfill Job as the
      // runtime role. `create index if not exists` is refused `42501 must be owner` BEFORE
      // Postgres looks for the index, so re-applying idempotent DDL was never safe for this role.
      await applyLockedSchema(client as PostgresClient);
      await createDmlRole();
      const outcome = await withFixtureApp('fs-backfill-live', (root) =>
        bootAsDmlRole(root).then(
          () => 'booted',
          (error: unknown) => (error as { code?: string }).code ?? String(error),
        ),
      );
      expect(outcome).toBe('booted');
    },
    TIMEOUT_MS,
  );

  test(
    'the same role over a database no migrate stamped is refused, naming the migrate step',
    async () => {
      await applyFrameworkSchema((statement) => (client as PostgresClient).execute(raw(statement)));
      await createDmlRole();
      const error = await withFixtureApp('fs-backfill-live', (root) =>
        bootAsDmlRole(root).then(
          () => undefined,
          (thrown: unknown) => thrown as { code?: string; cause?: string; fix?: string },
        ),
      );
      expect(error?.code).toBe('X_FRAMEWORK_SCHEMA_FAILED');
      expect(error?.cause).toContain('42501');
      expect(error?.fix).toContain('x db migrate');
      expect(error?.fix).toContain('owns');
    },
    TIMEOUT_MS,
  );
});
