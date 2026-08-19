// The check, not the three fixes: no `/_x` source may read a key its registry does not publish.
//
// Three panels were wrong for every row — every route `render: 'stream'` with no budget and no
// revalidate tag, every job non-idempotent, every schema drift-free — because `data.ts` read the
// descriptors as untyped bags and the names it guessed (`render`, `budget`, `revalidate`,
// `idempotencyKey`, `drift`) belong to no descriptor. A bag read of a name nobody publishes is
// `undefined`, `undefined` takes the fallback, and the fallback renders as a fact.
//
// Two halves close it, and both are needed. `data.ts` now reads each registry through its own
// descriptor TYPE, so a renamed field is a typecheck failure naming the field. This file walks
// what the real registries actually EMIT, which is the half a type cannot answer: a field the
// type declares and the projection never writes, or a `dist/*.d.ts` that has gone stale against
// the source it was built from, is a green typecheck and a blank cell.
//
// The lists are the keys `data.ts` reads, one per registry. `satisfies` refuses a name the
// descriptor type does not have; the walk refuses a name the descriptor object does not carry.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ColumnDescription, EntityDescription } from '@ultimat3/entity';
import { clearRegistry, describeEntities, entity, text, uuid } from '@ultimat3/entity';
import type { JobDescriptor } from '@ultimat3/jobs';
import { describeJobs, job, resetJobs, t } from '@ultimat3/jobs';
import type { RouteDescriptor } from '@ultimat3/render';
import { clearRoutes, defineRoute, describeRoutes, registerRoute } from '@ultimat3/render';

const ROUTE_READS = [
  'path',
  'file',
  'mode',
  'offline',
  'hydrate',
  'revalidateTags',
  'budgetJs',
  'budgetLcp',
] as const satisfies readonly (keyof RouteDescriptor)[];

const JOB_READS = [
  'name',
  'queue',
  'steps',
  'retry',
  'idempotent',
] as const satisfies readonly (keyof JobDescriptor)[];

const JOB_RETRY_READS = [
  'attempts',
  'backoff',
] as const satisfies readonly (keyof JobDescriptor['retry'])[];

const ENTITY_READS = [
  'name',
  'table',
  'columns',
] as const satisfies readonly (keyof EntityDescription)[];

const COLUMN_READS = [
  'column',
  'kind',
  'notNull',
] as const satisfies readonly (keyof ColumnDescription)[];

// Registered in `beforeAll`, never at module scope: `bun test` seats every file of this package
// in one process, and the suites that share these registries clear them when they finish.
beforeAll(() => {
  clearRoutes();
  registerRoute({
    file: 'apps/web/app/published-keys/page.tsx',
    config: defineRoute({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'idle',
      budget: { js: '12kb', lcp: 2_000 },
      revalidate: { tags: [{ entity: 'published_keys_widget' }], ttl: 60 },
      meta: () => ({ title: 'Published keys' }),
    }),
  });
  entity('published_keys_widget', {
    columns: { id: uuid().primaryKey(), label: text({ max: 40 }) },
  });
  job({
    name: 'published_keys_digest',
    tenant: 'none',
    queue: 'mail',
    input: t.object({ orgId: t.string }),
    idempotencyKey: (input: { orgId: string }) => `published-keys:${input.orgId}`,
    retry: { attempts: 3, backoff: 'linear' },
    run: () => Promise.resolve(),
  });
});

afterAll(() => {
  clearRoutes();
  clearRegistry();
  resetJobs();
});

/** Absent is the bug; `undefined` under a present key is the same blank cell, so both fail. */
const published = (descriptor: object, key: string): boolean =>
  Object.hasOwn(descriptor, key) &&
  (descriptor as Readonly<Record<string, unknown>>)[key] !== undefined;

describe('every key /_x reads is a key the registry publishes', () => {
  test('the route table publishes all eight fields the routes panel is built from', () => {
    const descriptor = describeRoutes().find(
      (route) => route.file === 'apps/web/app/published-keys/page.tsx',
    );
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    for (const key of ROUTE_READS) expect([key, published(descriptor, key)]).toEqual([key, true]);
    // The premise. `budgetJs`/`budgetLcp` are `null` on a route that declares no budget, and a
    // walk over a descriptor whose optional halves are all null would pass while proving nothing.
    expect(descriptor.budgetJs).toBe('12kb');
    expect(descriptor.budgetLcp).toBe(2_000);
    expect(descriptor.revalidateTags.length).toBeGreaterThan(0);
  });

  test('the job registry publishes every field the jobs panel is built from, retry included', () => {
    const descriptor = describeJobs().find((entry) => entry.name === 'published_keys_digest');
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    for (const key of JOB_READS) expect([key, published(descriptor, key)]).toEqual([key, true]);
    for (const key of JOB_RETRY_READS) {
      expect([key, published(descriptor.retry, key)]).toEqual([key, true]);
    }
    // `idempotencyKey` is the DEFINITION's field, and the one the panel used to look for. A
    // descriptor must never carry it: it is computed from an input, so it is app data.
    expect(descriptor).not.toHaveProperty('idempotencyKey');
  });

  test('the entity registry publishes every field the tables panel is built from', () => {
    const descriptor = describeEntities().find(
      (entry) => entry.name === 'published_keys_widget' || entry.table === 'published_keys_widget',
    );
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    for (const key of ENTITY_READS) expect([key, published(descriptor, key)]).toEqual([key, true]);
    const column = descriptor.columns[0];
    expect(column).toBeDefined();
    if (column === undefined) return;
    for (const key of COLUMN_READS) expect([key, published(column, key)]).toEqual([key, true]);
  });

  // The premise under an ABSENT field. `RouteFact` publishes no `hasMeta` and the panel lists no
  // `missingMeta` because `defineRoute()` refuses a route with no `meta` function, so the answer
  // could only ever be "all of them, always". If render ever makes `meta` optional this goes red,
  // which is the moment that decision is worth taking again.
  test('a route with no meta cannot be declared, which is why no fact reports one', () => {
    // Cast, because the type already refuses this — the runtime backstop is what is under test,
    // and it is what a JS caller or a generator hits.
    const noMeta = { render: 'ssr', offline: 'network-only' } as unknown as Parameters<
      typeof defineRoute
    >[0];
    expect(() => defineRoute(noMeta)).toThrow(/meta/);
  });

  // The fourth read the db panel needs, and the one no registry can answer: drift is the entities
  // against the DATABASE. Nothing is published for it, so nothing may be read for it — the source
  // refuses (`data-registries.test.ts`) and the panel says the check did not run rather than `[]`.
  test('drift is published by no registry, so the entity description declares none', () => {
    const descriptor = describeEntities()[0];
    expect(descriptor).toBeDefined();
    expect(descriptor === undefined ? true : Object.hasOwn(descriptor, 'drift')).toBe(false);
  });
});
