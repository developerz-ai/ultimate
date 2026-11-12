// The probe's body in process, where coverage can see it: one migrated database for every seed, a
// row its entity refuses keeps its own code, a module that will not import and a database that will
// not open are each one failure at their own stage. `verify-seeds.test.ts` drives the real child.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { probeSeeds } from './verify-seeds-probe';

const SEED_FILE = 'packages/db/seeds/dev.ts';
const MIGRATION_FILE = 'packages/db/migrations/0001_init.sql';
const MIGRATION = `create table probe_plans (
  id uuid primary key, code text not null,
  monthly_minor bigint not null, monthly_currency char(3) not null, monthly_scale smallint
);
`;

/** `name` differs per fixture: in process, every module's entity registers into ONE registry. */
const seed = (minor: string, name: string): string => `import { db, sql } from '@ultimat3/db';
import { defineSeed, entity, money, text, uuid } from '@ultimat3/entity';
const plans = entity('${name}', {
  table: 'probe_plans',
  columns: { id: uuid().primaryKey(), code: text(), monthly: money() },
});
export const dev = defineSeed('probe-dev', async ({ insert, id }) => {
  await insert(plans, [{ id: id('plan:team'), code: 'team', monthly: { minor: ${minor}, currency: 'USD' } }]);
  const row = await db().one(sql\`select count(*)::int as n from probe_plans\`);
  if (row?.n !== 1) throw new TypeError('the entity rows went to another store');
});
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Inside this package, so the seed resolves `@ultimat3/*` as the child would. */
const appRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const dir = mkdtempSync(join(import.meta.dir, '..', '.seeds-probe-fixture-'));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) await Bun.write(join(dir, file), text);
  return dir;
};

/** One state directory for every run, so the scratch database boots from its snapshot cache. */
const state = mkdtempSync(join(import.meta.dir, '..', '.seeds-probe-state-'));
dirs.push(state);
const env = { ULTIMATE_STATE_DIR: state, TEST_DATABASE_URL: undefined, DATABASE_URL: undefined };

describe('unit · the seed probe, in process', () => {
  test(
    'entity rows and db() share one database; a float is the entity code; a bad module is import',
    async () => {
      const green = await appRoot({
        [SEED_FILE]: seed('1999', 'probe_green'),
        [MIGRATION_FILE]: MIGRATION,
      });
      expect(await probeSeeds(green, [SEED_FILE], env)).toEqual([]);

      const float = await appRoot({
        [SEED_FILE]: seed('19.99', 'probe_float'),
        [MIGRATION_FILE]: MIGRATION,
      });
      const [refused, ...rest] = await probeSeeds(float, [SEED_FILE], env);
      expect(rest).toEqual([]);
      expect(refused).toMatchObject({ stage: 'run', export: 'dev', seed: 'probe-dev' });
      expect(refused?.code).toBe('X_INVARIANT_VIOLATED');

      const broken = await appRoot({ [SEED_FILE]: 'export const = ;\n' });
      const [unimported] = await probeSeeds(broken, [SEED_FILE], env);
      expect(unimported).toMatchObject({ stage: 'import', file: SEED_FILE, export: '*' });
    },
    { timeout: 60_000 },
  );

  test('a database that will not open is one failure at stage database, with its code', async () => {
    const app = await appRoot({
      [SEED_FILE]: seed('1999', 'probe_unopened'),
      [MIGRATION_FILE]: `create extension if not exists postgis;\n${MIGRATION}`,
    });
    const [failure, ...rest] = await probeSeeds(app, [SEED_FILE], env);
    expect(rest).toEqual([]);
    expect(failure).toMatchObject({ stage: 'database', file: SEED_FILE });
    expect(failure?.code).toBe('X_SCHEMA_DUMP_DRIFT');
  });
});
