// Route `load`s in the exercise pass, on the memory driver: a page read that loops over rows grows
// 2 → 8 under the scale sweep as a handler's does, one read stays flat, an `:id` is bound to a
// seeded row, a param no seed names is unreached with why, and a guard nobody holds is refused.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import type { NamedActor } from '@ultimat3/policy';
import { definePermissions, testActor } from '@ultimat3/policy';
import type { RouteContext } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { RouteLoadRecord } from './exercise-route-loads';
import { routeLoadSubjects } from './exercise-route-subjects';
import { subjectsOf } from './exercise-subjects';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

definePermissions(['erl-note:read', 'erl-admin:do']);

const orgs = entity('erl_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const notes = entity('erl_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
  },
});
const driver = memoryDriver();
/** Every note key the seed wrote, any graph. */
const seeded = new Set<unknown>();
const writer: SeedWriter = {
  insert: async ({ entity: name, row }) => {
    if (name === orgs.$name) await driver.repo(orgs).insert(row as never);
    else {
      seeded.add(row['id']);
      await driver.repo(notes).insert(row as never);
    }
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};
const roles = (tenant: string): readonly NamedActor[] => [
  { name: 'anonymous', actor: null },
  testActor('reader', { permissions: ['erl-note:read'], orgId: tenant }),
];

/** The params each `:id` load was handed: a seeded note's key, never a drawn string. */
const boundIds: string[] = [];

const page = (file: string, load: (ctx: RouteContext) => Promise<object>, permission?: string) =>
  registerRoute({
    file,
    config: defineRoute({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      ...(permission === undefined ? {} : { policy: { permission } }),
      load,
      meta: () => ({ title: 'a page', description: 'a page under test' }),
    }),
  });

page(
  'apps/web/app/erl/loop/page.tsx',
  async () => {
    const all = await driver.repo(notes).findMany();
    for (const row of all.rows) await driver.repo(notes).findById(row.id);
    return { n: all.rows.length };
  },
  'erl-note:read',
);
page('apps/web/app/erl/flat/page.tsx', async () => ({
  n: (await driver.repo(notes).findMany()).rows.length,
}));
page('apps/web/app/erl/notes/[id]/page.tsx', async ({ params }) => {
  boundIds.push(params['id'] ?? '');
  return { note: await driver.repo(notes).findById(params['id'] ?? '') };
});
page('apps/web/app/erl/tags/[slug]/page.tsx', async () => ({}));
/** What the prerendered page's load was told: the route's own sample, never a drawn string. */
const sampled: string[] = [];
registerRoute({
  file: 'apps/web/site/erl/guides/[guide]/page.tsx',
  config: defineRoute({
    render: 'static',
    offline: 'network-only',
    hydrate: 'never',
    budget: { js: '0kb' },
    prerender: () => [{ params: { guide: 'intro' } }],
    load: async ({ params, url }) => {
      sampled.push(`${params['guide'] ?? ''} ${url}`);
      return {};
    },
    meta: () => ({ title: 'a guide', description: 'a guide under test' }),
  }),
});
page('apps/web/app/erl/admin/page.tsx', async () => ({}), 'erl-admin:do');

afterAll(() => {
  clearRoutes();
  clearRegistry();
});

/**
 * One pass for the file, shared as a promise: a second test asking while the first still runs waits
 * on it, never seeds the same driver twice. Only this file's routes — the route table is global, and
 * a directory run holds every other file's registrations beside these.
 */
let running: Promise<readonly RouteLoadRecord[]> | undefined;
const pass = (): Promise<readonly RouteLoadRecord[]> => {
  running ??= (async () => {
    let records: readonly RouteLoadRecord[] = [];
    // Every action, query and job another file left registered is `off` here: this file has none,
    // and a directory run would otherwise exercise theirs — one waited out its whole timeout.
    const others = (await subjectsOf()).map((subject) => [subject.name, { off: 'another file' }]);
    await runExercisePass({
      overrides: defineExercise(Object.fromEntries(others)),
      entities: [orgs, notes],
      writer,
      roles,
      seed: 3,
      routes: (await routeLoadSubjects()).filter((route) => route.file.includes('/erl/')),
      onRoutes: (got) => {
        records = got;
      },
    });
    return records;
  })();
  return running;
};
const one = async (name: string): Promise<RouteLoadRecord> => {
  const record = (await pass()).find((r) => r.name === name);
  if (record === undefined) return expect.unreachable(`no record for ${name}`);
  return record;
};

describe(testName('unit', 'runExercisePass · route loads'), () => {
  test('every file route with a load has a record, named by its pattern, pointing at its file', async () => {
    expect((await pass()).map((r) => r.name).sort()).toEqual([
      '/erl/admin',
      '/erl/flat',
      '/erl/guides/:guide',
      '/erl/loop',
      '/erl/notes/:id',
      '/erl/tags/:slug',
    ]);
    expect((await one('/erl/loop')).file).toBe('apps/web/app/erl/loop/page.tsx');
    // The whole pass runs inside this first test: the default 5 s is a cold start's, not its bound.
  }, 30_000);

  test('a load that loops over rows grows 2 -> 8: the page read is swept as a handler is', async () => {
    const record = await one('/erl/loop');
    expect(record.outcome).toBe('reached');
    expect(record.statements).toBeGreaterThan(1);
    expect(record.scale?.verdict).toBe('grows');
    expect(record.statementCeiling?.verdict).toBe('within');
  });

  test('a load with one read is flat', async () => {
    expect(await one('/erl/flat')).toMatchObject({
      outcome: 'reached',
      scale: { verdict: 'flat' },
    });
  });

  test("an :id is a seeded row's key the tenant sees", async () => {
    expect((await one('/erl/notes/:id')).outcome).toBe('reached');
    expect(boundIds.length).toBeGreaterThan(0);
    for (const id of boundIds) expect(seeded.has(id)).toBe(true);
  });

  test('a param no seed names and no prerender() fills is unreached, with why', async () => {
    const record = await one('/erl/tags/:slug');
    expect(record.outcome).toBe('unreached');
    expect(record.reason).toContain(':slug');
    expect(record.scale).toBeUndefined();
  });

  test("a param no seed names is filled by the route's own prerender() sample", async () => {
    expect((await one('/erl/guides/:guide')).outcome).toBe('reached');
    expect(sampled[0]).toBe('intro http://localhost/erl/guides/intro');
  });

  test('a guard no role holds is refused', async () => {
    expect((await one('/erl/admin')).outcome).toBe('refused');
  });
});
