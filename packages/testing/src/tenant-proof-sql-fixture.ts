// The tenant proof's SQL app: a tenant-columned table read and written by RAW SQL keyed on the
// input id — the hole the repository guard never sees — beside the scoped read of the same row.
// One client at a time (PGlite in the unit file, Postgres in the live one), installed by `useSql`.

import { expect } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { UltimateError } from '@ultimat3/core';
import { type DbClient, generateMigration, migrate, sql } from '@ultimat3/db';
import { entity, postgresRepo, text, uuid } from '@ultimat3/entity';
import { can, definePermissions } from '@ultimat3/policy';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import { entitySeedWriter } from './seed-writer';
import { tpRoles } from './tenant-proof-fixture';

// Declared here, never left to another file: the permission set is one per process, and once
// any file declares one, `can()` refuses a name nobody declared (X_PERMISSION_UNKNOWN) — so in
// one process, which file was imported first decided whether this one loaded.
definePermissions(['tp:read', 'tp:write']);

export const tpsOrgs = entity('tps_orgs', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});
export const tpsDocs = entity('tps_docs', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => tpsOrgs.id)
      .tenant(),
    body: text({ max: 120 }),
  },
});
const TPS_ENTITIES = { tpsOrgs, tpsDocs } as const;

let current: DbClient | undefined;

const client = (): DbClient => {
  if (current !== undefined) return current;
  throw new UltimateError({
    code: 'X_TEST_FIXTURE_UNAVAILABLE',
    cause: 'the tenant-proof SQL fixture ran with no client installed',
    fix: 'await useSql(client) before proveSql(name)',
  });
};

/** Migrate the two tables onto an EMPTY database and route every handler here through `db`. */
export async function useSql(db: DbClient): Promise<void> {
  const up = generateMigration({
    entities: [tpsOrgs.$describe(), tpsDocs.$describe()],
    name: 'tenant_proof',
    now: new Date('2026-11-05T00:00:00.000Z'),
  }).up;
  await migrate({
    migrations: [{ id: '1_tenant_proof', name: 'tenant_proof', up, down: '' }],
    client: db,
    lock: false,
  });
  current = db;
}

export const releaseSql = (): void => {
  current = undefined;
};

const missing = (): never => {
  throw new UltimateError({
    code: 'X_NOT_FOUND',
    cause: 'no such doc',
    fix: 'x exercise <name> --json   # bind a seeded id of the actor tenant',
  });
};

const byDoc = t.object({ tpsDocId: t.uuid });
const Body = t.object({ body: t.string });

registerActions({
  /** Hole 2: raw SQL by the input id, no tenant predicate. */
  tpsRawRead: action({
    input: byDoc,
    output: Body,
    policy: can('tp:read'),
    async handle({ input }) {
      const row = await client().one<{ body: string }>(
        sql`select body from tps_docs where id = ${input.tpsDocId}`,
      );
      return row === null ? missing() : { body: row.body };
    },
  }),
  /** Hole 7 in SQL: an unscoped UPDATE by input id on a tenant-COLUMNED table. */
  tpsRawWrite: action({
    input: byDoc,
    output: t.object({ ok: t.boolean }),
    policy: can('tp:write'),
    async handle({ input }) {
      await client().execute(
        sql`update tps_docs set body = 'overwritten-by-caller' where id = ${input.tpsDocId}`,
      );
      return { ok: true };
    },
  }),
  /** Green: the same row through the scoped repository. */
  tpsScopedRead: action({
    input: byDoc,
    output: Body,
    policy: can('tp:read'),
    async handle({ input }) {
      const doc = await postgresRepo(tpsDocs, { client: client() }).findById(input.tpsDocId);
      return doc === null ? missing() : { body: doc.body };
    },
  }),
});

/** One pass over one SQL primitive. `seed` differs per call: the rows are committed. */
export async function proveSql(only: string, seed: number): Promise<ExerciseRecord> {
  const records = await runExercisePass({
    entities: Object.values(TPS_ENTITIES),
    writer: entitySeedWriter({ entities: TPS_ENTITIES, client: client() }),
    roles: tpRoles,
    only,
    seed,
  });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
}

/** The ids of tps_docs rows the raw write overwrote. */
export async function overwrittenDocs(): Promise<readonly string[]> {
  const rows = await client().query<{ id: string }>(
    sql`select id from tps_docs where body = 'overwritten-by-caller'`,
  );
  return rows.map((row) => row.id);
}
