// `inBatches(size)` is the only read that hands back a resource rather than rows, so this pins
// three things a page terminal cannot go wrong at: that the batches are the chain's own pages and
// nothing else, that stopping early stops the statements and says where it stopped, and that a
// chain which cannot carry a cursor is refused before the first one goes out rather than after it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient } from '@ultimat3/db';
import type { BatchIterator } from './batch';
import { text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { EntityError } from './errors';
import { postgresRepo } from './pg-driver';
import { MAX_PAGE_SIZE } from './plan';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import { memoryRepo, type Repo } from './repo';

const orgs = entity('batch_test_orgs', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

const posts = entity('batch_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
    /** Nullable on purpose: an ordering no cursor can carry has to be expressible to be refused. */
    publishedAt: timestamp().nullable(),
  },
});

type Post = typeof posts.$row;

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`;

const post = (index: number, orgId: string = ORG): Post => ({
  id: id(index),
  orgId,
  title: `Post ${index}`,
  publishedAt: null,
});

/** Ids in tens, so a row written mid-iteration can land between two the loop already read. */
const ids = (...indexes: readonly number[]): readonly string[] => indexes.map(id);
const SEEDED = [0, 10, 20, 30, 40, 50, 60] as const;

/** Seven rows for the org under test, two more nobody iterating it may ever see. */
const seed: readonly Post[] = [
  ...SEEDED.map((index) => post(index)),
  post(90, OTHER),
  post(91, OTHER),
];

/** A repo that counts its reads: "one statement per batch" is a claim about calls, not about rows. */
interface Counted<Row> {
  readonly repo: Repo<Row>;
  reads(): number;
}

const counting = <Row>(inner: Repo<Row>): Counted<Row> => {
  let reads = 0;
  return {
    repo: {
      ...inner,
      findMany: (args) => {
        reads += 1;
        return inner.findMany(args);
      },
    },
    reads: () => reads,
  };
};

let table = tableFor(posts, memoryRepo(posts, seed));

beforeEach(() => {
  table = tableFor(posts, memoryRepo(posts, seed));
});

afterAll(() => {
  clearRegistry();
});

const feed = () => table.where({ orgId: ORG });

const drain = async (batches: BatchIterator<Post>): Promise<readonly (readonly Post[])[]> => {
  const seen: (readonly Post[])[] = [];
  for await (const batch of batches) seen.push(batch);
  return seen;
};

/** `toBeUltimateError` reads a value, and a chain-shaped refusal throws where it was written. */
const caught = (run: () => unknown): EntityError => {
  try {
    run();
  } catch (error) {
    if (error instanceof EntityError) return error;
    throw error;
  }
  throw new Error('expected a refusal, got a builder');
};

describe('the batches a chain yields', () => {
  test('every matching row, in order, size at a time', async () => {
    const batches = await drain(feed().inBatches(3));

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat().map((row) => row.id)).toEqual(ids(...SEEDED));
  });

  test('an empty batch is never yielded', async () => {
    expect(await drain(feed().andWhere('title', 'eq', 'nothing').inBatches(3))).toEqual([]);
    // Exactly divisible: the page after the last row is where a trailing empty batch would appear.
    expect((await drain(feed().andWhere('title', 'like', 'Post %').inBatches(7))).length).toBe(1);
  });

  test('a batch bigger than the result is one batch, not a first page', async () => {
    const batches = await drain(feed().inBatches(500));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(7);
  });

  test('the filter, the order and the projection are the chain’s', async () => {
    const batches = await drain(
      feed()
        .andWhere('title', 'like', 'Post %')
        .orderBy('title', 'desc')
        .select({ id: true })
        .inBatches(4),
    );
    const rows = batches.flat();

    expect(rows[0]).toEqual({ id: id(60) });
    expect(rows.map((row) => row.id)).toEqual(ids(...[...SEEDED].reverse()));
  });

  test('another tenant’s rows are outside every batch', async () => {
    const rows = (await drain(feed().inBatches(2))).flat();

    expect(rows).toHaveLength(7);
    expect(rows.some((row) => row.orgId === OTHER)).toBe(false);
  });

  test('a preloaded relation is attached to every batch, not only the first', async () => {
    const db = database({ orgs, posts });
    await db.orgs.insert({ id: ORG, name: 'Acme' });
    for (const row of seed.filter((candidate) => candidate.orgId === ORG)) {
      await db.posts.insert(row);
    }

    const batches = await drain(db.posts.where({ orgId: ORG }).preload('org').inBatches(3));

    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      for (const row of batch) expect(row.org).toEqual({ id: ORG, name: 'Acme' });
    }
  });
});

describe('one statement per batch, and none once it is closed', () => {
  let counted: Counted<Post>;

  beforeEach(() => {
    counted = counting(memoryRepo(posts, seed));
    table = tableFor(posts, counted.repo);
  });

  test('seven rows in threes is three reads, not seven', async () => {
    await drain(feed().inBatches(3));

    expect(counted.reads()).toBe(3);
  });

  test('breaking out of the loop stops the next statement', async () => {
    for await (const batch of feed().inBatches(3)) {
      expect(batch).toHaveLength(3);
      break;
    }

    expect(counted.reads()).toBe(1);
  });

  test('a throw inside the loop closes it too', async () => {
    const batches = feed().inBatches(3);
    await expect(
      (async () => {
        for await (const batch of batches) throw new Error(`boom on ${batch.length}`);
      })(),
    ).rejects.toThrow('boom on 3');

    expect(counted.reads()).toBe(1);
    expect((await batches[Symbol.asyncIterator]().next()).done).toBe(true);
  });

  test('await using closes the handle at the end of its scope', async () => {
    let held: BatchIterator<Post> | null = null;
    {
      await using batches = feed().inBatches(3);
      held = batches;
      const first = await batches[Symbol.asyncIterator]().next();
      expect(first.value).toHaveLength(3);
    }

    expect((await held[Symbol.asyncIterator]().next()).done).toBe(true);
    expect(counted.reads()).toBe(1);
  });

  test('close() is idempotent, and closing before the first batch reads nothing', async () => {
    const batches = feed().inBatches(3);
    await batches.close();
    await batches.close();

    expect(await drain(batches)).toEqual([]);
    expect(counted.reads()).toBe(0);
  });

  test('one handle is one iteration — a second loop continues it, never restarts it', async () => {
    const batches = feed().inBatches(3);
    const first = await drain(batches);
    const second = await drain(batches);

    expect(first.flat()).toHaveLength(7);
    expect(second).toEqual([]);
    expect(counted.reads()).toBe(3);
  });
});

describe('the position it stopped at', () => {
  test('the chain’s own cursor is where it starts', () => {
    expect(feed().inBatches(3).cursor).toBeNull();
    expect(feed().after('c_1').inBatches(3).cursor).toBe('c_1');
  });

  test('after an exhausted iteration there is no next batch', async () => {
    const batches = feed().inBatches(3);
    await drain(batches);

    expect(batches.cursor).toBeNull();
  });

  test('a break leaves the cursor the next batch starts from, and after() resumes it', async () => {
    const batches = feed().inBatches(3);
    const first: Post[] = [];
    for await (const batch of batches) {
      first.push(...batch);
      break;
    }

    expect(batches.cursor).not.toBeNull();
    const rest = (await drain(feed().after(batches.cursor).inBatches(3))).flat();

    expect(first.map((row) => row.id)).toEqual(ids(0, 10, 20));
    // Every remaining row exactly once: a resumed iteration neither repeats nor skips.
    expect(rest.map((row) => row.id)).toEqual(ids(30, 40, 50, 60));
  });
});

describe('keyset, so a concurrent write cannot shift the loop', () => {
  test('a row inserted before the cursor is not read twice, and one after it is read', async () => {
    const seen: Post[] = [];
    for await (const batch of feed().inBatches(3)) {
      seen.push(...batch);
      if (seen.length === 3) {
        // An OFFSET pagination would repeat a row here and skip another; a keyset one reads the
        // insert only where the sort order puts it, and never a row it already passed.
        await table.insert(post(15));
        await table.insert(post(45));
      }
    }

    expect(seen.map((row) => row.id)).toEqual(ids(0, 10, 20, 30, 40, 45, 50, 60));
  });

  test('deleting rows already consumed does not skip the ones after them', async () => {
    const seen: Post[] = [];
    for await (const batch of feed().inBatches(3)) {
      seen.push(...batch);
      // What an OFFSET loop gets wrong: every row deleted shifts the next page back over rows
      // nobody has read yet. The seek is a position in the sort order, so nothing moves.
      for (const row of batch) await table.delete(row.id, { orgId: ORG });
    }

    expect(seen.map((row) => row.id)).toEqual(ids(...SEEDED));
  });
});

describe('refused on the chain, not one batch later', () => {
  let counted: Counted<Post>;

  beforeEach(() => {
    counted = counting(memoryRepo(posts, seed));
    table = tableFor(posts, counted.repo);
  });

  // `MAX_PAGE_SIZE + 1` joins the list because a batch IS a page: `planFor` would refuse it one
  // statement in, in `limit()`'s voice, for an author who never wrote a `limit()`.
  test.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PAGE_SIZE + 1])(
    'inBatches(%p) is a refusal, not a statement',
    (size) => {
      expect(caught(() => feed().inBatches(size))).toBeUltimateError('X_INVARIANT_VIOLATED');
      expect(counted.reads()).toBe(0);
    },
  );

  test('a chain that also called limit() has written one number twice', () => {
    const error = caught(() => feed().limit(10).inBatches(500));

    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    // The fix is the caller's own bound as the batch size — the reading that keeps their intent.
    expect(error.fix).toContain('inBatches(10)');
  });

  test('an ordering no cursor can carry is refused even when one batch would have hidden it', () => {
    // The whole result fits in one batch, so nothing would ever mint a cursor and the mistake
    // would survive until the table grew — which is the trap this eager check exists for.
    expect(caught(() => feed().orderBy('publishedAt').inBatches(500))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    expect(counted.reads()).toBe(0);
  });

  test('tenancy is still the plan’s: an unscoped chain rejects on its first batch', async () => {
    const batches = table.inBatches(3);

    await expect(drain(batches)).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
  });
});

describe('the Postgres driver sends the same statement page() sends', () => {
  const physical = (index: number): Record<string, unknown> => ({
    id: id(index),
    org_id: ORG,
    title: `Post ${index}`,
    published_at: null,
  });

  let client: RecordingClient;
  let pg: ReturnType<typeof tableFor<Post, typeof posts.$columns>>;

  beforeEach(() => {
    client = createRecordingClient();
    pg = tableFor(posts, postgresRepo(posts, { client }));
  });

  test('one select per batch, each asking for one row past it', async () => {
    // Three rows for a batch of two: the row past the page is what says there is a next one.
    client.on('select', { rows: [physical(0), physical(1), physical(2)] });
    const seen: string[] = [];
    for await (const batch of pg.where({ orgId: ORG }).inBatches(2)) {
      seen.push(...batch.map((row) => row.id));
      client.on('select', { rows: [physical(3)] });
    }

    expect(seen).toEqual([id(0), id(1), id(3)]);
    expect(client.texts).toHaveLength(2);
    expect(client.statements[0]?.values.at(-1)).toBe(3);
  });

  test('the second batch seeks from the last row, never an offset', async () => {
    client.on('select', { rows: [physical(0), physical(1), physical(2)] });
    for await (const _batch of pg.where({ orgId: ORG }).inBatches(2)) {
      client.on('select', { rows: [] });
    }
    const second = client.texts[1] ?? '';

    expect(second).not.toContain('offset');
    expect(second).toContain('("id" > $2)');
    expect(second).toContain('"org_id" = $1');
    expect(client.statements[1]?.values[1]).toBe(id(1));
  });

  test('a refused chain sends nothing at all', () => {
    expect(caught(() => pg.where({ orgId: ORG }).limit(5).inBatches(5))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    expect(client.statements).toHaveLength(0);
  });
});
