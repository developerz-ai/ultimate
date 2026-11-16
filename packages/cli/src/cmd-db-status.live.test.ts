// `x db status` against a real Postgres: a fresh database reads as nothing applied and is left
// exactly as it was (no ledger created, no stamp written), a migrated one is current, a ledger
// ahead of the build is listed and served, an edited migration is the ledger conflict.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`: this file creates and drops a
// database.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:fs` — Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import { LEDGER_TABLE, migrate, postgresClient, setDbClient } from '@ultimat3/db';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { exec } from './exec';
import { applyLockedSchema } from './framework-schema-apply';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { renderJson } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
const PROBE_DB = probeDatabaseName('x_db_status_probe');
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

const adminExecutor = {
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    on<R>(url ?? '', text, values),
};

let root = '';

beforeEach(async () => {
  await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
  await sweepProbeDatabases(adminExecutor, PROBE_DB);
  await on(url ?? '', `create database ${PROBE_DB}`);
  root = mkdtempSync(join(tmpdir(), 'x-db-status-live-'));
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(
    join(root, MIGRATIONS_DIR, '20260101000000_a.sql'),
    '-- up\ncreate table "a" ("id" text primary key);\n-- down\ndrop table "a";\n',
  );
}, TIMEOUT_MS);

afterEach(async () => {
  setDbClient(undefined);
  rmSync(root, { recursive: true, force: true });
  await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
}, TIMEOUT_MS);

afterAll(async () => {
  if (url !== undefined) await on(url, `drop database if exists ${PROBE_DB} with (force)`);
});

interface Body {
  readonly ok: boolean;
  readonly findings: readonly { readonly code: string }[];
  readonly data: {
    readonly applied: readonly string[] | null;
    readonly pending: readonly string[];
    readonly ahead: readonly string[];
    readonly edited: readonly string[];
    readonly framework: { readonly applied: boolean };
  };
}

const status = async (): Promise<Body> => {
  const ctx: CommandContext = {
    args: parseArgs(['db', 'status', '--json'], SPECS),
    cwd: root,
    runner: exec,
    env: { DATABASE_URL: probeUrl(), ULTIMATE_STATE_DIR: join(root, '.x') },
    bunVersion: REQUIRED_BUN,
  };
  return JSON.parse(renderJson(await dbCommand.run(ctx))) as Body;
};

/** Every relation in `public`: what a read-only command must leave exactly as it found it. */
const relations = (): Promise<readonly unknown[]> =>
  on(probeUrl(), "select relname from pg_class where relnamespace = 'public'::regnamespace");

/** Stamp the framework and migrate the app, as `ROLE=migrate` would. */
async function migrated(): Promise<void> {
  const client = postgresClient({ url: probeUrl() });
  try {
    await applyLockedSchema(client);
    await migrate({ client, migrations: await readMigrations(root), lock: false });
  } finally {
    await client.close();
  }
}

describeLive('live · x db status on Postgres', () => {
  test(
    'a fresh database: nothing applied, and nothing written to say so',
    async () => {
      const before = await relations();
      const body = await status();
      expect(body.data.applied).toBeNull();
      expect(body.data.pending).toEqual(['20260101000000_a']);
      expect(body.data.framework.applied).toBe(false);
      expect(body.ok).toBe(false);
      expect(await relations()).toEqual(before);
    },
    TIMEOUT_MS,
  );

  test(
    'migrated: current; a ledger ahead is listed and served; an edit is the conflict',
    async () => {
      await migrated();
      expect(await status()).toMatchObject({ ok: true, findings: [] });

      await on(
        probeUrl(),
        `insert into ${LEDGER_TABLE} (id, name, checksum, app_version, duration_ms) values ('20270101000000_z', 'z', 'abc', '99.0.0', 1)`,
      );
      const ahead = await status();
      expect(ahead.data.ahead).toEqual(['20270101000000_z']);
      expect(ahead.ok).toBe(true);

      await on(
        probeUrl(),
        `update ${LEDGER_TABLE} set checksum = '${'0'.repeat(64)}' where id = '20260101000000_a'`,
      );
      const edited = await status();
      expect(edited.data.edited).toEqual(['20260101000000_a']);
      expect(edited.findings.map((finding) => finding.code)).toEqual(['X_MIGRATION_CONFLICT']);
    },
    TIMEOUT_MS,
  );
});
