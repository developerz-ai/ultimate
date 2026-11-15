// A route load's `defineExercise(…, { routes })` entry, honoured by the pass: params it names or
// computes in the load's own request, an actor (or the app's resolution of one, facts and all) the
// role grants cannot give, a moved statement ceiling, and `off` — an unknown pattern refused.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { actorFact, assert, isUltimateError, useContext, userActor } from '@ultimat3/core';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import type { NamedActor } from '@ultimat3/policy';
import { definePermissions, testActor } from '@ultimat3/policy';
import type { RouteContext } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { defineExercise } from './define-exercise';
import type { RouteExerciseOverride } from './define-exercise-routes';
import { runExercisePass } from './exercise';
import type { RouteLoadRecord } from './exercise-route-loads';
import { routeLoadSubjects } from './exercise-route-subjects';
import { subjectsOf } from './exercise-subjects';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

declare module '@ultimat3/core' {
  interface ActorFacts {
    readonly eroBadge: string;
  }
}

beforeAll(() => {
  definePermissions(['ero-note:read', 'ero-admin:do']);
});

const orgs = entity('ero_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const notes = entity('ero_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
  },
});
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ entity: name, row }) => {
    if (name === orgs.$name) await driver.repo(orgs).insert(row as never);
    else await driver.repo(notes).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};
const roles = (tenant: string): readonly NamedActor[] => [
  { name: 'anonymous', actor: null },
  testActor('reader', { permissions: ['ero-note:read'], orgId: tenant }),
];

/** What each load was told, by pattern: its params and who it ran as. */
const told = new Map<string, { params: Record<string, string>; actor: Actor }>();

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

const remember = (path: string) => async (ctx: RouteContext) => {
  told.set(path, { params: { ...ctx.params }, actor: useContext().actor });
  return { n: (await driver.repo(notes).findMany()).rows.length };
};

page('apps/web/app/ero/tags/[slug]/page.tsx', remember('/ero/tags/:slug'));
page('apps/web/app/ero/orgs/[org]/page.tsx', remember('/ero/orgs/:org'));
page('apps/web/app/ero/admin/page.tsx', remember('/ero/admin'), 'ero-admin:do');
page('apps/web/app/ero/badge/page.tsx', async () => {
  const badge = actorFact(useContext().actor, 'eroBadge');
  // Refused as an app page refuses an unresolved fact: the load fails, so the record says so.
  assert(
    badge !== undefined,
    'the actor carries no badge fact',
    "actor: (seated) => ({ ...seated, facts: { eroBadge: 'gold' } })",
  );
  return { badge };
});
page('apps/web/app/ero/loop/page.tsx', async () => {
  const all = await driver.repo(notes).findMany();
  for (const row of all.rows) await driver.repo(notes).findById(row.id);
  return {};
});
page('apps/web/app/ero/off/page.tsx', remember('/ero/off'));
page('apps/web/app/ero/about/page.tsx', async () => ({ about: 'static' }));
/** The URL each query-reading load was told. */
const urls: string[] = [];
page('apps/web/app/ero/consent/page.tsx', async ({ url }) => {
  urls.push(url);
  return {};
});

afterAll(() => {
  clearRoutes();
  clearRegistry();
});

const ADMIN = userActor({ id: 'ero-admin', roles: [], permissions: ['ero-admin:do'] });

const ROUTES: Readonly<Record<string, RouteExerciseOverride>> = {
  '/ero/tags/:slug': { params: { slug: 'launch' } },
  '/ero/orgs/:org': { params: async () => ({ org: useContext().actor.orgId ?? 'none' }) },
  '/ero/admin': { actor: ADMIN },
  '/ero/badge': {
    actor: (seated) => (seated === null ? null : { ...seated, facts: { eroBadge: 'gold' } }),
  },
  '/ero/loop': { statements: { max: 1, why: 'the test moves it below the loop' } },
  '/ero/off': { off: 'measured by its own e2e test' },
  '/ero/about': { empty: 'a static page: its load reads nothing' },
  '/ero/consent': { search: async () => `client=${useContext().actor.orgId ?? 'none'}` },
};

const runWith = async (
  routes: Readonly<Record<string, RouteExerciseOverride>>,
  shard?: { readonly index: number; readonly total: number },
) => {
  let records: readonly RouteLoadRecord[] = [];
  const others = (await subjectsOf()).map((subject) => [subject.name, { off: 'another file' }]);
  await runExercisePass({
    overrides: defineExercise(Object.fromEntries(others), { routes }),
    entities: [orgs, notes],
    writer,
    roles,
    // A seed per shard: the rows are committed, and one driver holds every pass's.
    seed: 5 + (shard?.index ?? 0),
    ...(shard === undefined ? {} : { shard }),
    routes: (await routeLoadSubjects()).filter((route) => route.file.includes('/ero/')),
    onRoutes: (got) => {
      records = got;
    },
  });
  return records;
};

let running: Promise<readonly RouteLoadRecord[]> | undefined;
/** The whole pass, once for the file: a second ask waits on the first. */
const whole = (): Promise<readonly RouteLoadRecord[]> => {
  running ??= runWith(ROUTES);
  return running;
};
const one = async (name: string): Promise<RouteLoadRecord> => {
  const record = (await whole()).find((r) => r.name === name);
  if (record === undefined) return expect.unreachable(`no record for ${name}`);
  return record;
};

describe(testName('unit', 'runExercisePass · route entries'), () => {
  test('declared params reach the load, where no seed names the param', async () => {
    expect((await one('/ero/tags/:slug')).outcome).toBe('reached');
    expect(told.get('/ero/tags/:slug')?.params).toEqual({ slug: 'launch' });
  }, 30_000);

  test('computed params run in the load’s request, as its actor in its tenant', async () => {
    expect((await one('/ero/orgs/:org')).outcome).toBe('reached');
    const seen = told.get('/ero/orgs/:org');
    expect(seen?.params['org']).toBe(seen?.actor.orgId);
  });

  test('a declared actor loads a page no role grant may, moved into the route’s tenant', async () => {
    expect((await one('/ero/admin')).outcome).toBe('reached');
    const actor = told.get('/ero/admin')?.actor;
    expect(actor?.id).toBe('ero-admin');
    expect(typeof actor?.orgId).toBe('string');
  });

  test('an actor function resolves the seated actor as the request boundary would: facts', async () => {
    expect(await one('/ero/badge')).toMatchObject({ outcome: 'reached' });
  });

  test('a moved ceiling is the one the load is held to', async () => {
    const record = await one('/ero/loop');
    expect(record.statementCeiling).toMatchObject({ verdict: 'over', max: 1 });
  });

  test('off is off, with its reason, and the load never ran', async () => {
    expect(await one('/ero/off')).toMatchObject({
      outcome: 'off',
      reason: 'measured by its own e2e test',
    });
    expect(told.has('/ero/off')).toBe(false);
  });

  test('a load that reads nothing carries its entry’s why; one that reads never does', async () => {
    expect(await one('/ero/about')).toMatchObject({
      outcome: 'reached',
      statements: 0,
      empty: 'a static page: its load reads nothing',
    });
    expect((await one('/ero/tags/:slug')).empty).toBeUndefined();
  });

  test('a declared query string is on the URL the load is told, computed in its request', async () => {
    expect((await one('/ero/consent')).outcome).toBe('reached');
    const [url] = urls;
    expect(url).toStartWith('http://localhost/ero/consent?client=');
    expect(url).not.toEndWith('client=none');
  });

  test('two shards run every route once between them, and none twice', async () => {
    const all = (await whole()).map((r) => r.name).sort();
    const first = (await runWith(ROUTES, { index: 1, total: 2 })).map((r) => r.name);
    const second = (await runWith(ROUTES, { index: 2, total: 2 })).map((r) => r.name);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.filter((name) => second.includes(name))).toEqual([]);
    expect([...first, ...second].sort()).toEqual(all);
  }, 30_000);

  test('a pattern no route registers is refused before a row is written', async () => {
    const refused = await runWith({ '/ero/tag/:slug': { params: { slug: 'x' } } }).then(
      () => 'ran',
      (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
    );
    expect(refused).toBe('X_DECLARATION_UNKNOWN');
  });
});
