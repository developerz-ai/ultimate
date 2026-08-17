// Single responsibility: WHO a cached read may be handed back to. `cache.test.ts` proves how many
// times the read path reaches for the tier; this proves that two callers reaching for the same
// name, input and tags are not automatically reaching for the same entry.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { declareTags, isolateDeclaredTags, tag } from '@ultimat3/cache';
import { createContext, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { cacheKeyFor, readAuthority } from './cache';
import { query } from './query';
import { runQuery } from './read';
import { getReadCache, MemoryReadCache, setReadCache } from './read-cache';
import { from } from './source';

const original = getReadCache();

/** The `cache:` fixtures below tag `post`, and the graph validates a tag against the registry. */
const restoreTags = isolateDeclaredTags();
declareTags(['post']);

/** Fresh tier per test: the module default is a process-wide singleton other files share. */
beforeEach(() => {
  setReadCache(new MemoryReadCache());
});

afterAll(() => {
  setReadCache(original);
  restoreTags();
});

/**
 * The tier is process-wide and its key held the query name, the input and the tags — nothing about
 * who asked. `sql(input, ctx)` is handed the context and `@ultimat3/entity` derives every tenant
 * predicate from `ctx.actor.orgId`, so two actors asking one question with one input are asking
 * two different questions: the first one to arrive filled the entry and the second was served it.
 */
describe('the authority a cached read was answered under', () => {
  interface SecretRow {
    readonly id: string;
    readonly orgId: string;
    readonly secret: string;
  }

  const ROWS: readonly SecretRow[] = [
    { id: 'a1', orgId: 'org-a', secret: 'ALPHA' },
    { id: 'b1', orgId: 'org-b', secret: 'BRAVO' },
  ];

  /** Filters on the ACTOR's org, exactly as a tenant-scoped repository read does. */
  function tenantFeed(name: string, scope?: 'actor' | 'tenant' | 'global') {
    const counts = { executed: 0 };
    const target = query({
      input: t.object({ q: t.string }),
      policy: allow(),
      cache: {
        tags: [tag('post')],
        ttlMs: 60_000,
        ...(scope === undefined ? {} : { scope }),
      },
      sql: (_input: { q: string }, ctx) =>
        from<SecretRow>('rows', async () => {
          counts.executed += 1;
          return ROWS.filter((row) => row.orgId === ctx.actor.orgId);
        }),
    }).named(name);
    return { target, counts };
  }

  const asOrg = (
    id: string,
    orgId?: string,
  ): { readonly ctx: ReturnType<typeof createContext> } => ({
    ctx: createContext({ actor: userActor(orgId === undefined ? { id } : { id, orgId }) }),
  });

  test('an org-b actor is never served the org-a entry', async () => {
    const { target, counts } = tenantFeed('leakFeed');

    const first = await runQuery(target, { q: 'all' }, asOrg('u-a', 'org-a'));
    const second = await runQuery(target, { q: 'all' }, asOrg('u-b', 'org-b'));

    expect(first).toEqual([{ id: 'a1', orgId: 'org-a', secret: 'ALPHA' }]);
    expect(second).toEqual([{ id: 'b1', orgId: 'org-b', secret: 'BRAVO' }]);
    // Two authorities, two keys, two reads: the shared entry is what the leak was.
    expect(counts.executed).toBe(2);
  });

  test('the default scope is the actor, so one org-mate does not answer for another', async () => {
    const { target, counts } = tenantFeed('perActorFeed');

    await runQuery(target, { q: 'all' }, asOrg('u-a', 'org-a'));
    await runQuery(target, { q: 'all' }, asOrg('u-a2', 'org-a'));

    expect(counts.executed).toBe(2);
  });

  test("scope: 'tenant' shares inside one org and never across two", async () => {
    const { target, counts } = tenantFeed('tenantFeed', 'tenant');

    await runQuery(target, { q: 'all' }, asOrg('u-a', 'org-a'));
    await runQuery(target, { q: 'all' }, asOrg('u-a2', 'org-a'));
    expect(counts.executed).toBe(1);

    const other = await runQuery(target, { q: 'all' }, asOrg('u-b', 'org-b'));
    expect(other).toEqual([{ id: 'b1', orgId: 'org-b', secret: 'BRAVO' }]);
    expect(counts.executed).toBe(2);
  });

  test("scope: 'tenant' with no org narrows to the actor rather than widening to everyone", async () => {
    const { target, counts } = tenantFeed('orglessFeed', 'tenant');

    await runQuery(target, { q: 'all' }, asOrg('u-a'));
    await runQuery(target, { q: 'all' }, asOrg('u-b'));

    // Nothing proves two actors with no org share a tenant, so the key declines to say they do.
    expect(counts.executed).toBe(2);
  });

  test("scope: 'global' is the written opt-out, and it shares one entry", async () => {
    const { target, counts } = tenantFeed('publicFeed', 'global');

    await runQuery(target, { q: 'all' }, asOrg('u-a', 'org-a'));
    await runQuery(target, { q: 'all' }, asOrg('u-b', 'org-b'));

    expect(counts.executed).toBe(1);
  });

  test('an uncached read is keyed the same way, so no second key function can grow', async () => {
    const actor = userActor({ id: 'u-a', orgId: 'org-a' });
    const other = userActor({ id: 'u-b', orgId: 'org-b' });

    expect(cacheKeyFor('feed', { q: 'all' }, [], readAuthority(actor, 'actor'))).not.toBe(
      cacheKeyFor('feed', { q: 'all' }, [], readAuthority(other, 'actor')),
    );
    expect(readAuthority(actor, 'global')).toBe(readAuthority(other, 'global'));
  });

  test('two distinct actors never share an authority, however their ids are spelled', () => {
    // JSON, never a joined string — the rule `@ultimat3/entity`'s `scopeKey` states: an actor id
    // is app data, and a value that can spell the separator can spell a boundary it does not own.
    const actors = [
      userActor({ id: 'u-a', orgId: 'org-a' }),
      userActor({ id: 'u-a:org-a' }),
      userActor({ id: 'u-a' }),
      userActor({ id: 'u-a', orgId: '' }),
      userActor({ id: 'u-a"', orgId: 'org-a' }),
    ];

    const authorities = actors.map((actor) => readAuthority(actor, 'actor'));
    expect(new Set(authorities).size).toBe(actors.length);
  });
});
