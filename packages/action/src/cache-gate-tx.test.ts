// The bust and the transaction it runs inside. An action invoked inside a `withTransaction` has
// committed nothing when its handler returns: a bust there lets a concurrent read refill the cache
// with pre-commit rows that then stay for the TTL, and a rollback busts for a write nobody made.
// A fake scope pins the rule; PGlite pins it against the real `onCommit`.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { CacheTag, CacheTier, TierInvalidation } from '@ultimat3/cache';
import {
  declareTags,
  isolateDeclaredTags,
  isolateTiers,
  registerTier,
  resetDeclaredTags,
  resetTiers,
  tag,
} from '@ultimat3/cache';
import { ctxOf } from '@ultimat3/core';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, raw, sql, withTransaction } from '@ultimat3/db';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { bustAfterCommit } from './cache-gate';

let busts: string[] = [];

const tier: CacheTier = {
  name: 'lru',
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  del: () => Promise.resolve(),
  invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
    busts.push(...tags.map((value) => value.entity));
    return Promise.resolve({ tier: 'lru', keys: [] });
  },
};

const restoreTiers = isolateTiers();
const restoreTags = isolateDeclaredTags();

/** A bust is fired from a commit effect, which is synchronous: the fan-out lands a turn later. */
const settled = (): Promise<void> => Bun.sleep(0);

const arrange = (): void => {
  busts = [];
  declareTags(['post']);
  registerTier(tier);
};

afterEach(() => {
  resetTiers();
  resetDeclaredTags();
});

afterAll(() => {
  restoreTiers();
  restoreTags();
});

describe('the bust inside a transaction — a fake scope', () => {
  test('it waits for the commit effect, and lands when the scope runs it', async () => {
    arrange();
    const effects: (() => void)[] = [];
    const scope = { onCommit: (effect: () => void) => void effects.push(effect) };

    expect(await bustAfterCommit('publishPost', [tag('post')], scope)).toBeUndefined();
    await settled();
    expect(busts).toEqual([]);
    expect(effects).toHaveLength(1);

    for (const effect of effects) effect();
    await settled();
    expect(busts).toEqual(['post']);
  });

  test('a scope that drops its effects — a rollback — busts nothing', async () => {
    arrange();
    const scope = { onCommit: (_effect: () => void): void => {} };
    await bustAfterCommit('publishPost', [tag('post')], scope);
    await settled();
    expect(busts).toEqual([]);
  });

  test('a deferred bust that refuses is absorbed in the effect, never thrown into the commit', async () => {
    arrange();
    const effects: (() => void)[] = [];
    const scope = { onCommit: (effect: () => void) => void effects.push(effect) };
    await bustAfterCommit('publishPost', [tag('feed')], scope);
    expect(() => {
      for (const effect of effects) effect();
    }).not.toThrow();
    await settled();
    expect(busts).toEqual([]);
  });

  test('outside any transaction it busts at once, as before', async () => {
    arrange();
    const report = await bustAfterCommit('publishPost', [tag('post')]);
    expect(report?.tags).toEqual(['post']);
    expect(busts).toEqual(['post']);
  });
});

describe('the bust inside a transaction — PGlite, through invoke', () => {
  let client: PgliteClient;
  const ctx = ctxOf({});

  const publish = action({
    input: t.object({ id: t.number }),
    output: t.object({ id: t.number }),
    policy: allow(),
    cache: { invalidates: [tag('post')] },
    async handle({ input }) {
      await withTransaction(
        (tx) => tx.execute(sql`insert into bust_posts (id) values (${input.id})`),
        { client },
      );
      return { id: input.id };
    },
  }).named('publishBustPost');

  const stored = async (): Promise<number[]> =>
    (await client.query<{ id: number }>(raw('select id from bust_posts order by id'))).map(
      (row) => row.id,
    );

  beforeAll(async () => {
    client = pgliteClient();
    await client.execute(raw('create table bust_posts (id integer primary key)'));
  });

  afterAll(async () => {
    await client.close();
  });

  afterEach(async () => {
    await client.execute(raw('delete from bust_posts'));
  });

  test('an action in a transaction that COMMITS busts after the commit, never before', async () => {
    arrange();
    await withTransaction(
      async () => {
        await publish({ id: 1 }, { ctx });
        await settled();
        // The handler returned and its row is still uncommitted: a bust here is the stale refill.
        expect(busts).toEqual([]);
      },
      { client },
    );
    await settled();
    expect(busts).toEqual(['post']);
    expect(await stored()).toEqual([1]);
  });

  test('an action in a transaction that ROLLS BACK busts nothing', async () => {
    arrange();
    const failure = await withTransaction(
      async () => {
        await publish({ id: 2 }, { ctx });
        throw new RangeError('the outer unit of work failed after the action returned');
      },
      { client },
    ).catch((error: unknown) => error);

    await settled();
    expect(failure).toBeInstanceOf(RangeError);
    expect(await stored()).toEqual([]);
    expect(busts).toEqual([]);
  });

  test('a transaction the server aborted — a swallowed failed statement — busts nothing', async () => {
    arrange();
    const failure = await withTransaction(
      async (tx) => {
        await publish({ id: 3 }, { ctx });
        await tx.execute(raw('insert into bust_posts (id) values (3)')).catch(() => undefined);
      },
      { client },
    ).catch((error: unknown) => error);

    await settled();
    expect(failure).toBeUltimateError('X_DB_TRANSACTION_ABORTED');
    expect(await stored()).toEqual([]);
    expect(busts).toEqual([]);
  });

  // A promise chain the body forgot to await finds the FINISHED scope's handle. What its bust
  // does is `DbTx.onCommit`'s own answer — at once after a COMMIT, dropped after a ROLLBACK — and
  // it is the answer `@ultimat3/entity`'s row observer gets for the same write, from the same call.
  const touch = action({
    input: t.object({}),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    cache: { invalidates: [tag('post')] },
    handle: () => ({ ok: true }),
  }).named('touchBustPost');

  const straggle = async (ending: 'commit' | 'rollback'): Promise<void> => {
    const gate = Promise.withResolvers<void>();
    let straggler: Promise<unknown> = Promise.resolve();
    await withTransaction(
      () => {
        straggler = gate.promise.then(() => touch({}, { ctx }));
        return ending === 'commit'
          ? Promise.resolve()
          : Promise.reject(new RangeError('the unit of work failed'));
      },
      { client },
    ).catch(() => undefined);
    gate.resolve();
    await straggler;
    await settled();
  };

  test('a straggler that outlives a COMMIT busts at once — it is never queued on a dead scope', async () => {
    arrange();
    await straggle('commit');
    expect(busts).toEqual(['post']);
  });

  test('a straggler that outlives a ROLLBACK is dropped, exactly as its row report is', async () => {
    arrange();
    await straggle('rollback');
    expect(busts).toEqual([]);
  });

  test('with no transaction open the action busts when it returns, as before', async () => {
    arrange();
    await publish({ id: 4 }, { ctx });
    expect(busts).toEqual(['post']);
  });
});
