// Direct coverage of "the one read path" — what `query.test.ts` reaches only through `runQuery`:
// the declaration store (`hasDef`/`defOf`/`stashDef`), `queryName`, the authz-before-execute
// ordering proved with a spy, impersonation via `options.actor`, and `buildSource`'s `total()`.

import { afterAll, describe, expect, test } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import {
  createLruTier,
  declareTags,
  invalidateTags,
  isolateDeclaredTags,
  isolateTiers,
  registerTier,
  resetTiers,
  tag,
} from '@ultimat3/cache';
import { createContext, userActor } from '@ultimat3/core';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { cacheKeyFor, DEFAULT_READ_CACHE_TTL_MS, readAuthority } from './cache';
import { QueryDeniedError, QueryForeignError, QueryUnregisteredError } from './errors';
import type { AnyQuery } from './query';
import { query } from './query';
import { defOf, hasDef, queryName, runQuery, sourceFor } from './read';
import type { SqlSource } from './source';
import { from } from './source';

interface Row {
  readonly id: string;
  readonly orgId: string;
}

/**
 * The `cache:` block below tags `post`, and the fan-out validates a tag against the declared
 * entities. Declared here so it runs against a real registry instead of the disabled one an empty
 * registry means — and restored, so no later file inherits it.
 */
const restoreTags = isolateDeclaredTags();
declareTags(['post']);
afterAll(restoreTags);

/**
 * A registered `lru` tier, with the TTL spread turned off so an expiry is a number a test may
 * assert. There is no read cache to install: the read path fills the tiers `@ultimat3/cache` has
 * registered, which is the whole of what C3 changed.
 */
let readTier: CacheTier & { readonly cache: unknown };
let restoreTiers: (() => void) | undefined;
const withReadTier = (): void => {
  restoreTiers?.();
  restoreTiers = isolateTiers();
  resetTiers();
  readTier = createLruTier({ jitterFraction: 0 });
  registerTier(readTier);
};
afterAll(() => {
  restoreTiers?.();
  restoreTiers = undefined;
});

const ORG = '00000000-0000-4000-8000-000000000001';
const Input = t.object({ orgId: t.uuid });
const rows: readonly Row[] = [{ id: 'a', orgId: ORG }];

const allowedActor = { ...userActor({ id: 'allowed' }), permissions: ['feed:read'] };
const otherActor = { ...userActor({ id: 'other' }), permissions: ['feed:read'] };
const allowedCtx = createContext({ actor: allowedActor });

/** Counts real executions of the source, so "guard runs before sql" is a number, not a claim. */
function defineCountedQuery(policy = allow()) {
  const counts = { built: 0, executed: 0 };
  const target = query({
    input: Input,
    policy,
    sql: ({ orgId }: { orgId: string }) => {
      counts.built += 1;
      return from<Row>('rows', async () => {
        counts.executed += 1;
        return rows.filter((row) => row.orgId === orgId);
      }).where({ orgId });
    },
  }).named('countedFeed');
  return { target, counts };
}

describe('hasDef / defOf — the private declaration store', () => {
  test('a query built via query() has a stashed def, readable through defOf', () => {
    const target = query({
      input: Input,
      policy: allow(),
      sql: () => from<Row>('rows', rows),
    }).named('someFeed');

    expect(hasDef(target)).toBe(true);
    const def = defOf(target);
    expect(def.input).toBe(Input);
    expect(def.policy).toBe(target.policy);
  });

  test('a look-alike function is not recognized — hasDef is false', () => {
    const foreign = Object.assign(() => Promise.resolve([]), { kind: 'query' as const });
    expect(hasDef(foreign)).toBe(false);
  });

  test('defOf throws QueryForeignError naming the target — anonymous when it has no name', () => {
    const foreign = Object.assign(() => Promise.resolve([]), { kind: 'query' as const });
    let caught: unknown;
    try {
      defOf(foreign as unknown as AnyQuery);
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(QueryForeignError);
    expect((caught as QueryForeignError).code).toBe('X_QUERY_FOREIGN');
    expect((caught as QueryForeignError).cause).toContain('anonymous');
  });

  test('defOf on a named foreign function includes that name in the cause', () => {
    function namedForeign() {
      return Promise.resolve([]);
    }
    Object.assign(namedForeign, { kind: 'query' as const });
    let caught: unknown;
    try {
      defOf(namedForeign as unknown as AnyQuery);
    } catch (thrown) {
      caught = thrown;
    }
    expect((caught as QueryForeignError).cause).toContain('namedForeign');
  });
});

describe('queryName', () => {
  test('a query named via .named() returns that name', () => {
    const target = query({
      input: Input,
      policy: allow(),
      sql: () => from<Row>('rows', rows),
    }).named('orgFeed');
    expect(queryName(target)).toBe('orgFeed');
  });

  test('an unregistered (anonymous) query throws QueryUnregisteredError', () => {
    const target = query({ input: Input, policy: allow(), sql: () => from<Row>('rows', rows) });
    let caught: unknown;
    try {
      queryName(target);
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(QueryUnregisteredError);
    expect((caught as QueryUnregisteredError).code).toBe('X_QUERY_UNREGISTERED');
  });
});

describe('runQuery — validate, authorize, then read, never out of order', () => {
  test('happy path: valid input against an allowing policy returns the fixture rows', async () => {
    const { target } = defineCountedQuery();
    const result = await runQuery(target, { orgId: ORG }, { ctx: allowedCtx });
    expect(result).toEqual(rows);
  });

  test('invalid input throws QueryInputInvalidError with a path:message detail, and sql() never runs', async () => {
    const { target, counts } = defineCountedQuery();
    const failure = await runQuery(target, { orgId: 'not-a-uuid' }, { ctx: allowedCtx }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
    expect((failure as { cause?: string }).cause).toContain('orgId');
    expect(counts.built).toBe(0);
    expect(counts.executed).toBe(0);
  });

  test('a denying policy throws QueryDeniedError and sql() never runs', async () => {
    const strict = can('feed:read', ({ actor }) => actor?.id === 'allowed');
    const { target, counts } = defineCountedQuery(strict);
    const failure = await runQuery(
      target,
      { orgId: ORG },
      { ctx: createContext({ actor: otherActor }) },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(QueryDeniedError);
    expect((failure as QueryDeniedError).code).toBe('X_FORBIDDEN');
    expect(counts.built).toBe(0);
    expect(counts.executed).toBe(0);
  });
});

describe('sourceFor — authorized but not yet run', () => {
  test('returns the built SqlSource without executing it', async () => {
    const { target, counts } = defineCountedQuery();
    const source = await sourceFor(target, { orgId: ORG }, { ctx: allowedCtx });

    expect(counts.built).toBe(1); // sql() itself ran, to produce the source
    expect(counts.executed).toBe(0); // but nothing read from it yet

    const result = await source.execute();
    expect(result).toEqual(rows);
    expect(counts.executed).toBe(1);
  });
});

describe('the per-request memo applies whether or not the query declares cache:', () => {
  test('two runQuery calls with identical input in one context execute the source once', async () => {
    const { target, counts } = defineCountedQuery();
    const ctx = createContext({ actor: allowedActor });

    const first = await runQuery(target, { orgId: ORG }, { ctx });
    const second = await runQuery(target, { orgId: ORG }, { ctx });

    expect(second).toEqual(first);
    expect(counts.executed).toBe(1);
  });

  test('options.fresh: true bypasses the memo and executes again', async () => {
    const { target, counts } = defineCountedQuery();
    const ctx = createContext({ actor: allowedActor });

    await runQuery(target, { orgId: ORG }, { ctx });
    await runQuery(target, { orgId: ORG }, { ctx, fresh: true });

    expect(counts.executed).toBe(2);
  });
});

describe('options.actor — impersonation on the one read path', () => {
  const dualPolicy = can('feed:read', ({ actor }) => actor?.id === 'allowed');

  test('allows via impersonation despite the ambient context actor being denied', async () => {
    const { target } = defineCountedQuery(dualPolicy);
    const ambient = createContext({ actor: otherActor }); // would be denied on its own

    const result = await runQuery(target, { orgId: ORG }, { ctx: ambient, actor: allowedActor });
    expect(result).toEqual(rows);
  });

  test('denies via impersonation despite the ambient context actor being allowed', async () => {
    const { target } = defineCountedQuery(dualPolicy);
    const ambient = createContext({ actor: allowedActor }); // would be allowed on its own

    const failure = await runQuery(
      target,
      { orgId: ORG },
      { ctx: ambient, actor: otherActor },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryDeniedError);
  });

  test("actor: null models the signed-out caller — core's anonymous actor, denied X_UNAUTHENTICATED", async () => {
    const { target } = defineCountedQuery(dualPolicy);
    const ambient = createContext({ actor: allowedActor });

    const failure = await sourceFor(target, { orgId: ORG }, { ctx: ambient, actor: null }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_UNAUTHENTICATED');
  });
});

describe("buildSource's live surface: total() when the source implements it", () => {
  const shapeOf = (entity: string) => ({
    entity,
    filters: [],
    orderBy: [],
    limit: null,
    unsupported: [],
  });

  test('surface: "live" returns source.total() when present, and never calls it otherwise', async () => {
    const totalSource: SqlSource<object> = {
      toSQL: () => ({ sql: 'select * from "totalized"', params: [] }),
      execute: async () => [{ tag: 'total' }],
      shape: () => shapeOf('totalized'),
    };
    let totalCalls = 0;
    const plainSource: SqlSource<object> = {
      toSQL: () => ({ sql: 'select * from "plain"', params: [] }),
      execute: async () => [{ tag: 'plain' }],
      shape: () => shapeOf('plain'),
      total: () => {
        totalCalls += 1;
        return totalSource;
      },
    };
    const target = query({ input: Input, policy: allow(), sql: () => plainSource }).named(
      'liveTotalFeed',
    );

    const live = await sourceFor(target, { orgId: ORG }, { ctx: allowedCtx, surface: 'live' });
    expect(live).toBe(totalSource);
    expect(totalCalls).toBe(1);

    const server = await sourceFor(target, { orgId: ORG }, { ctx: allowedCtx, surface: 'server' });
    expect(server).toBe(plainSource);
    expect(totalCalls).toBe(1); // unchanged — a non-live surface never calls total(), even present
  });

  test('surface: "live" returns the source unchanged when it has no total()', async () => {
    const noTotalSource: SqlSource<object> = {
      toSQL: () => ({ sql: 'select * from "nototal"', params: [] }),
      execute: async () => [{ tag: 'no-total' }],
      shape: () => shapeOf('nototal'),
    };
    const target = query({ input: Input, policy: allow(), sql: () => noTotalSource }).named(
      'liveNoTotalFeed',
    );

    const live = await sourceFor(target, { orgId: ORG }, { ctx: allowedCtx, surface: 'live' });
    expect(live).toBe(noTotalSource);
  });
});

describe("a cache: read's tier entry, and what drops it", () => {
  /** Fresh tier per test: the module default is a process-wide singleton other files share. */
  function defineCachedQuery(ttlMs?: number) {
    const counts = { executed: 0 };
    const target = query({
      input: Input,
      policy: allow(),
      cache: ttlMs === undefined ? { tags: [tag('post')] } : { tags: [tag('post')], ttlMs },
      sql: () =>
        from<Row>('rows', async () => {
          counts.executed += 1;
          return rows;
        }),
    }).named(`cachedFeed${counts.executed}${ttlMs ?? 'default'}`);
    return { target, counts };
  }

  // The measured failure: the entry lived in a store no fan-out could reach, so the pre-write
  // list was served for the life of the process. It is now dropped by `invalidateTags` — the very
  // call an action's `cache.invalidates` makes, with nothing in between.
  test('an invalidateTags fan-out drops it, and the next request re-reads', async () => {
    withReadTier();
    const { target, counts } = defineCachedQuery();

    await runQuery(target, { orgId: ORG }, { ctx: createContext({ actor: allowedActor }) });
    await runQuery(target, { orgId: ORG }, { ctx: createContext({ actor: allowedActor }) });
    expect(counts.executed).toBe(1); // second request served from the tier

    await invalidateTags([tag('post')]);

    await runQuery(target, { orgId: ORG }, { ctx: createContext({ actor: allowedActor }) });
    expect(counts.executed).toBe(2);
  });

  test('a cache: block with no ttlMs still writes a bounded expiry', async () => {
    withReadTier();
    const { target } = defineCachedQuery();
    const before = Date.now();

    await runQuery(target, { orgId: ORG }, { ctx: createContext({ actor: allowedActor }) });

    const key = cacheKeyFor(
      queryName(target),
      { orgId: ORG },
      [tag('post')],
      readAuthority(allowedActor, 'actor'),
    );
    const entry = await readTier.get(key);
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_READ_CACHE_TTL_MS);
    expect(entry?.tags).toEqual([tag('post')]);
  });

  test('a declared ttlMs is honoured over the default', async () => {
    withReadTier();
    const { target } = defineCachedQuery(5_000);
    const before = Date.now();

    await runQuery(target, { orgId: ORG }, { ctx: createContext({ actor: allowedActor }) });

    const key = cacheKeyFor(
      queryName(target),
      { orgId: ORG },
      [tag('post')],
      readAuthority(allowedActor, 'actor'),
    );
    const entry = await readTier.get(key);
    expect(entry?.expiresAt).toBeLessThan(before + DEFAULT_READ_CACHE_TTL_MS);
  });
});
