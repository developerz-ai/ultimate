// `frameworkSources` is the one place the primitive registries are projected onto the manifest's
// fact shapes, and it is the reason `buildManifest` can stay a pure function of its input. Nothing
// imported this file, so its projection ran only in a real app — where a field it dropped shows up
// as a fact silently missing from a committed `x.manifest.json`.
//
// Registered against the REAL registries, never a fake: a stub that returned descriptor-shaped
// objects would prove the stub, and the projection's whole job is to read the descriptors the
// framework actually produces.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  action,
  mutator,
  registerAction,
  resetRegistry as resetActions,
  t,
} from '@ultimat3/action';
import { tag } from '@ultimat3/cache';
import { clearRegistry as clearEntities, entity, invariant, text, uuid } from '@ultimat3/entity';
import { job, resetJobs } from '@ultimat3/jobs';
import { and, can } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { frameworkSources } from './sources';

const APP = { name: 'acme', version: '1.4.2' } as const;

beforeAll(() => {
  clearEntities();
  resetActions();
  resetQueries();
  resetJobs();

  entity('sources_test_post', {
    table: 'sources_test_posts',
    columns: {
      id: uuid().primaryKey(),
      title: text({ max: 80 }),
      // camelCase on purpose: the physical column is snake_case, so a projection reading the
      // PROPERTY instead of the column publishes a name no SQL statement uses.
      authorName: text({ max: 80 }).nullable(),
    },
    invariants: (c) => [invariant('title_present', c.title.trimmed().minLength(1))],
  });

  registerAction(
    'publishSourcesPost',
    action({
      input: t.object({ id: t.uuid }),
      output: t.object({ id: t.uuid }),
      policy: can('post:publish'),
      cache: { invalidates: [tag('feed'), tag('post')] },
      rateLimit: { limit: 1000, windowMs: 60_000 },
      mcp: { expose: true, description: 'publish a draft post' },
      handle: ({ input }) => ({ id: input.id }),
    }),
  );

  registerAction(
    'archiveSourcesPost',
    mutator({
      input: t.object({ id: t.uuid }),
      output: t.object({ id: t.uuid }),
      policy: and(can('post:archive'), can('org:administer')),
      conflict: 'server-wins',
      local: () => undefined,
      server: (_ctx, input) => ({ id: input.id }),
    }),
  );

  registerQuery(
    'recentSourcesPosts',
    query({
      input: t.object({ limit: t.number.default(10) }),
      policy: can('post:read'),
      live: true,
      cache: { tags: [tag('feed')] },
      sql: ({ limit }) =>
        from<{ id: string }>('sources_test_posts', () => [])
          .orderBy('id')
          .limit(limit),
    }),
  );

  job({
    tenant: 'none',
    name: 'sourcesTestOnboard',
    queue: 'critical',
    input: t.object({ orgId: t.string }),
    idempotencyKey: ({ orgId }) => `onboard:${orgId}`,
    retry: { attempts: 5, backoff: 'exponential' },
    run: () => Promise.resolve(),
  });
});

afterAll(() => {
  clearEntities();
  resetActions();
  resetQueries();
  resetJobs();
});

describe('frameworkSources reaches every registry', () => {
  test('each of the four registries contributes its own section', () => {
    const sources = frameworkSources({ app: APP });
    // Not "is defined" — the NAME the registry holds, so a projection wired to the wrong
    // registry (or to none) fails rather than reporting an empty list as success.
    expect(sources.entities?.map((e) => e.name)).toEqual(['sources_test_post']);
    expect(sources.actions?.map((a) => a.name)).toEqual([
      'archiveSourcesPost',
      'publishSourcesPost',
    ]);
    expect(sources.queries?.map((q) => q.name)).toEqual(['recentSourcesPosts']);
    expect(sources.jobs?.map((j) => j.name)).toEqual(['sourcesTestOnboard']);
    expect(sources.app).toBe(APP);
  });

  test('the caller-supplied halves pass through, and default to empty rather than absent', () => {
    // Routes live in `@ultimat3/render` and policies are assembled per app — neither is a
    // registry this tier may read, so both arrive as arguments.
    const routes = [{ url: '/posts', render: 'isr' as const }];
    const policies = [{ permission: 'post:publish', enforcedIn: ['http'] }];
    const supplied = frameworkSources({ app: APP, routes, policies, locales: ['en', 'de'] });
    expect(supplied.routes).toEqual(routes);
    expect(supplied.policies).toEqual(policies);
    expect(supplied.locales).toEqual(['en', 'de']);

    const bare = frameworkSources({ app: APP });
    // `[]` and not `undefined`: `buildManifest` writes an empty array either way, but a caller
    // reading `sources.routes.length` must not have to guard.
    expect(bare.routes).toEqual([]);
    expect(bare.policies).toEqual([]);
    expect(bare.tasks).toEqual([]);
    expect(bare.locales).toEqual([]);
    expect(bare.errorCodes).toEqual([]);
  });
});

describe('the entity projection', () => {
  test('renames the descriptor fields the manifest publishes under other names', () => {
    const fact = frameworkSources({ app: APP }).entities?.[0];
    expect(fact?.table).toBe('sources_test_posts');
    // An invariant crosses as its NAME alone — the predicate is code and cannot be a JSON fact.
    expect(fact?.invariants).toEqual(['title_present']);
    // `column` -> `name`, `kind` -> `type`, and `notNull` INVERTED into `nullable`.
    expect(fact?.columns).toEqual([
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
      { name: 'title', type: 'text', nullable: false, primaryKey: false },
      { name: 'author_name', type: 'text', nullable: true, primaryKey: false },
    ]);
  });

  test('a column with no foreign key carries no `references` key at all', () => {
    const fact = frameworkSources({ app: APP }).entities?.[0];
    // The descriptor's `references` is `null`; writing that through would add a null per column
    // to a file reviewed by hand.
    expect(fact?.columns.every((column) => !('references' in column))).toBe(true);
  });
});

describe('the action projection', () => {
  const factFor = (name: string) =>
    frameworkSources({ app: APP }).actions?.find((a) => a.name === name);

  test('the policy LABEL and the flattened permissions are both carried', () => {
    const fact = factFor('publishSourcesPost');
    expect(fact?.policy).toBe('post:publish');
    expect(fact?.permissions).toEqual(['post:publish']);
    // A COMPOSITE is where the two fields stop agreeing: the label is not a permission and
    // matches no grant, so a projection reading `capability` into both publishes one fictional
    // entry and drops the two real ones.
    const composite = factFor('archiveSourcesPost');
    expect(composite?.policy).toBe('and(post:archive, org:administer)');
    expect(composite?.permissions).toEqual(['org:administer', 'post:archive']);
    expect(fact?.cacheInvalidates).toEqual(['feed', 'post']);
    expect(fact?.input).toMatchObject({ type: 'object' });
    expect(fact?.output).toMatchObject({ type: 'object' });
  });

  test('rateLimit, mcp.description and mutator are written only when declared', () => {
    const declared = factFor('publishSourcesPost');
    expect(declared?.rateLimit).toEqual({ limit: 1000, windowMs: 60_000 });
    expect(declared?.mcp).toEqual({ expose: true, description: 'publish a draft post' });
    expect('mutator' in (declared ?? {})).toBe(false);

    const bare = factFor('archiveSourcesPost');
    expect('rateLimit' in (bare ?? {})).toBe(false);
    // Nothing declared an `mcp` block, and the descriptor answers `expose: false` — projected
    // as the fact it is, with no description key beside it.
    expect(bare?.mcp).toEqual({ expose: false });
    expect('description' in (bare?.mcp ?? {})).toBe(false);
    // A mutator IS an action, and its descriptor's `kind` is still `'action'` — the flag is the
    // only thing downstream has to go on, and the manifest's mutator count reads zero without it.
    expect(bare?.mutator).toBe(true);
  });
});

describe('the query and job projections', () => {
  test('a query carries its label, permissions, liveness and cache tags', () => {
    const fact = frameworkSources({ app: APP }).queries?.[0];
    expect(fact?.policy).toBe('post:read');
    expect(fact?.permissions).toEqual(['post:read']);
    expect(fact?.live).toBe(true);
    // `tags` on the descriptor, `cacheTags` in the manifest.
    expect(fact?.cacheTags).toEqual(['feed']);
  });

  test('a job carries its queue and retry policy, and no steps', () => {
    const fact = frameworkSources({ app: APP }).jobs?.[0];
    expect(fact?.queue).toBe('critical');
    expect(fact?.retry).toEqual({ attempts: 5, backoff: 'exponential' });
    expect(fact?.input).toMatchObject({ type: 'object' });
    // Empty BY CONSTRUCTION, not dropped: a step name is chosen inside `run()`, so no static
    // reader can know it.
    expect(fact?.steps).toEqual([]);
  });
});
