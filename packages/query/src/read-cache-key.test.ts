// Single responsibility: a read's cache key is the PARSED input the policy decided about, never
// the raw payload. Keyed raw, an unknown search key (`?junk=N`) that the schema strips was a new
// tier entry and a database read per N — and every one of them evicted a hot entry.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  declareTags,
  isolateDeclaredTags,
  isolateTiers,
  lruTier,
  registerTier,
  resetTiers,
  tag,
} from '@ultimat3/cache';
import { ctxOf, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { toLiveQuery } from './live';
import { parsedQueryInput } from './parsed-input';
import { query, queryHash } from './query';
import { runQuery } from './read';
import { from } from './source';

let restore: (() => void) | undefined;
const restoreTags = isolateDeclaredTags();
declareTags(['post']);

beforeEach(() => {
  restore?.();
  restore = isolateTiers();
  resetTiers();
  registerTier(lruTier());
});

afterAll(() => {
  restore?.();
  restore = undefined;
  restoreTags();
});

function counted(name: string) {
  const counts = { executed: 0 };
  const target = query({
    input: t.object({ q: t.string }),
    policy: allow(),
    cache: { tags: [tag('post')], ttlMs: 60_000, scope: 'global' },
    sql: (input: { q: string }) =>
      from<{ readonly id: string }>('rows', async () => {
        counts.executed += 1;
        return [{ id: input.q }];
      }),
  }).named(name);
  return { target, counts };
}

const asReader = () => ({ ctx: ctxOf({ actor: userActor({ id: 'u-1' }) }) });

describe('the read cache key', () => {
  test('{ q } then { q, junk } is one entry and one read', async () => {
    const { target, counts } = counted('junkFeed');

    await runQuery(target, { q: 'a' }, asReader());
    await runQuery(target, { q: 'a', junk: 1 }, asReader());
    await runQuery(target, { q: 'a', junk: 2 }, asReader());

    expect(counts.executed).toBe(1);
  });

  test('a different declared value is still a different entry', async () => {
    const { target, counts } = counted('distinctFeed');

    await runQuery(target, { q: 'a' }, asReader());
    await runQuery(target, { q: 'b' }, asReader());

    expect(counts.executed).toBe(2);
  });

  test('over HTTP, ?junk= varies nothing the tier is keyed on', async () => {
    const { target, counts } = counted('junkRoute');
    const server = httpServer({
      routes: [toQueryRoute(target)],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => userActor({ id: 'u-1' }) },
    });
    const get = (search: string): Promise<Response> =>
      server.fetch(new Request(`http://dev.test/_x/query/junk-route${search}`));

    for (const search of ['?q=a', '?q=a&junk=1', '?q=a&junk=2', '?junk=3&q=a']) {
      expect((await get(search)).status).toBe(200);
    }

    expect(counts.executed).toBe(1);
  });
});

describe('parsedQueryInput', () => {
  test('answers the input the schema keeps, which is what every key hashes', async () => {
    const { target } = counted('parsedFeed');

    expect(await parsedQueryInput(target, { q: 'a', junk: 1 })).toEqual({ q: 'a' });
  });

  test('refuses an input the schema refuses, with the read path’s own code', async () => {
    const { target } = counted('refusedFeed');

    await expect(parsedQueryInput(target, { q: 1 })).rejects.toMatchObject({
      code: 'X_INPUT_INVALID',
    });
  });
});

describe('a live read’s identity', () => {
  test('`.live()` hashes the parsed input: a stripped key is the same window and cursor scope', async () => {
    const feed = query({
      input: t.object({ q: t.string }),
      policy: allow(),
      live: true,
      sql: (input: { q: string }) =>
        from<{ readonly id: string; readonly q: string }>('rows', [{ id: 'a', q: input.q }])
          .where({ q: input.q })
          .orderBy('id')
          .limit(10),
    }).named('liveJunk');
    const { ctx } = asReader();

    const plain = await toLiveQuery(feed, { q: 'a' }, { ctx, epoch: 'e' });
    const junk = await toLiveQuery(feed, { q: 'a', junk: 1 }, { ctx, epoch: 'e' });

    expect(junk.queryHash).toBe(plain.queryHash);
    expect(plain.queryHash).toBe(queryHash('liveJunk', { q: 'a' }));
  });
});
