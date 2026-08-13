// What a page of rows buys the lookups that follow it. The headline is the sequential loop —
// `for … of` awaits between iterations, so the microtask coalescer cannot see two of its lookups
// at once and only the page they came from can batch them. The rest is the scope guard: a
// preloaded row is served to a lookup the preload statement WAS, and to no other.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import {
  createRecordingClient,
  type DbClient,
  type RecordingClient,
  setDbClient,
} from '@ultimat3/db';
import { MAX_IDS_PER_STATEMENT } from './batch-read';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const users = entity('jit_test_users', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    name: text({ max: 40 }),
    deletedAt: timestamp().nullable(),
  },
});

const posts = entity('jit_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    authorId: uuid().references(() => users.id),
    /** Nullable on purpose: a post nobody reviewed is data, not a key to go looking for. */
    reviewerId: uuid()
      .references(() => users.id)
      .nullable(),
    title: text({ max: 80 }),
  },
});

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const ORG = idAt(1);
const OTHER_ORG = idAt(2);

/** What Bun.SQL hands back: snake_case names. */
const postRow = (id: string, authorId: string, over: Record<string, unknown> = {}): unknown => ({
  id,
  org_id: ORG,
  author_id: authorId,
  reviewer_id: null,
  title: `P-${id.slice(-2)}`,
  ...over,
});

const userRow = (id: string, over: Record<string, unknown> = {}): unknown => ({
  id,
  org_id: ORG,
  name: `U-${id.slice(-2)}`,
  deleted_at: null,
  ...over,
});

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const postRepo = () => postgresRepo(posts);
const userRepo = () => postgresRepo(users);
const inRequest = <T>(work: () => Promise<T>): Promise<T> => runWithContext(createContext(), work);

/** A page of three posts by three authors, and the three authors it will be asked for. */
const aPageOfThree = (): void => {
  client.on('from "jit_test_posts"', {
    rows: [postRow(idAt(10), idAt(20)), postRow(idAt(11), idAt(21)), postRow(idAt(12), idAt(22))],
  });
  client.on('from "jit_test_users"', {
    rows: [userRow(idAt(20)), userRow(idAt(21)), userRow(idAt(22))],
  });
};

const authorsOfThePage = async (): Promise<readonly (string | null)[]> => {
  const page = await postRepo().findMany({ orgId: ORG });
  const names: (string | null)[] = [];
  // A `for … of` awaits between iterations, so no two of these lookups share a microtask.
  for (const post of page.rows) {
    const author = await userRepo().findById(post.authorId, { orgId: ORG });
    names.push(author?.name ?? null);
  }
  return names;
};

describe('a page batches the lookups it causes', () => {
  test('a sequential loop over a page is two statements, not one per row', async () => {
    aPageOfThree();
    const names = await inRequest(authorsOfThePage);

    expect(client.statements).toHaveLength(2);
    expect(client.texts[1]).toContain('"id" in ($1, $2, $3)');
    expect(names).toEqual(['U-20', 'U-21', 'U-22']);
  });

  test('the concurrent form is the same two statements', async () => {
    aPageOfThree();
    const names = await inRequest(async () => {
      const page = await postRepo().findMany({ orgId: ORG });
      const authors = await Promise.all(
        page.rows.map((post) => userRepo().findById(post.authorId, { orgId: ORG })),
      );
      return authors.map((author) => author?.name ?? null);
    });

    expect(client.statements).toHaveLength(2);
    expect(names).toEqual(['U-20', 'U-21', 'U-22']);
  });

  test('a hundred rows by one author is one bind, not a hundred statements', async () => {
    client.on('from "jit_test_posts"', {
      rows: Array.from({ length: 40 }, (_, index) => postRow(idAt(100 + index), idAt(20))),
    });
    client.on('from "jit_test_users"', { rows: [userRow(idAt(20))] });
    const names = await inRequest(authorsOfThePage);

    expect(client.statements).toHaveLength(2);
    expect(client.statements[1]?.values).toEqual([idAt(20), ORG, 1]);
    expect(names.every((name) => name === 'U-20')).toBe(true);
  });

  test('rows are served by id, never by the order they came back in', async () => {
    client.on('from "jit_test_posts"', {
      rows: [postRow(idAt(10), idAt(20)), postRow(idAt(11), idAt(21))],
    });
    // Reversed on purpose: a caller served by position would get the other row.
    client.on('from "jit_test_users"', { rows: [userRow(idAt(21)), userRow(idAt(20))] });

    expect(await inRequest(authorsOfThePage)).toEqual(['U-20', 'U-21']);
  });

  test('an id the preload did not find is null, exactly as the single statement answered', async () => {
    aPageOfThree();
    client.on('from "jit_test_users"', { rows: [userRow(idAt(20))] });

    expect(await inRequest(authorsOfThePage)).toEqual(['U-20', null, null]);
    expect(client.statements).toHaveLength(2);
  });

  test('two lookups of one preloaded id are one row object', async () => {
    aPageOfThree();
    const [first, second] = await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      return [
        await userRepo().findById(idAt(20), { orgId: ORG }),
        await userRepo().findById(idAt(20), { orgId: ORG }),
      ];
    });

    expect(client.statements).toHaveLength(2);
    expect(first).toBe(second);
  });

  test('a key that resolved to nothing is not a row to go looking for', async () => {
    client.on('from "jit_test_posts"', {
      rows: [
        postRow(idAt(10), idAt(20), { reviewer_id: idAt(30) }),
        postRow(idAt(11), idAt(21), { reviewer_id: null }),
        postRow(idAt(12), idAt(22), { reviewer_id: idAt(31) }),
      ],
    });
    await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await userRepo().findById(idAt(30), { orgId: ORG });
    });

    // The two reviewers that exist, and neither the null nor any author: a second key to the same
    // entity is its own group, and a key nobody set contributes nothing to it.
    expect(client.statements[1]?.values).toEqual([idAt(30), idAt(31), ORG, 2]);
  });

  test('a page wider than the cap preloads whole statements, never one Postgres refuses', async () => {
    const rows = Array.from({ length: MAX_IDS_PER_STATEMENT + 1 }, (_, index) =>
      postRow(idAt(1000 + index), idAt(2000 + index)),
    );
    client.on('from "jit_test_posts"', { rows });
    await inRequest(async () => {
      const page = await postRepo().findMany({ orgId: ORG, limit: rows.length });
      await userRepo().findById(page.rows[0]?.authorId ?? '', { orgId: ORG });
    });

    expect(client.statements).toHaveLength(3);
    // ids + the org predicate + the limit.
    expect(client.statements[1]?.values).toHaveLength(MAX_IDS_PER_STATEMENT + 2);
    expect(client.statements[2]?.values).toHaveLength(3);
  });
});

describe('the scope a preloaded row may be served to', () => {
  test('the preload statement carries the scope the single lookups carried', async () => {
    aPageOfThree();
    await inRequest(authorsOfThePage);

    expect(client.texts[1]).toContain('"org_id" = $4');
    expect(client.texts[1]).toContain('"deleted_at" is null');
    expect(client.statements[1]?.values).toEqual([idAt(20), idAt(21), idAt(22), ORG, 3]);
  });

  test('another tenant is never served from this one, and never shares its statement', async () => {
    aPageOfThree();
    await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await userRepo().findById(idAt(20), { orgId: ORG });
      await userRepo().findById(idAt(20), { orgId: OTHER_ORG });
    });

    expect(client.statements).toHaveLength(3);
    // Its own statement, carrying its own predicate: the other tenant's rows are unreachable from
    // it, so the answer is the one this caller's single statement would have produced.
    expect(client.statements[2]?.values).toEqual([idAt(20), idAt(21), idAt(22), OTHER_ORG, 3]);
  });

  test('a lookup that reveals soft-deleted rows is never served the ones that hide them', async () => {
    aPageOfThree();
    // `RepoOptions` is what `findById` takes and `shapeOf` reads `includeDeleted` off it — the
    // live suite passes it, so the two visibilities have to be two statements.
    const revealed = { orgId: ORG, includeDeleted: true };
    await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await userRepo().findById(idAt(20), { orgId: ORG });
      await userRepo().findById(idAt(20), revealed);
    });

    expect(client.statements).toHaveLength(3);
    expect(client.texts[2]).not.toContain('"deleted_at" is null');
  });

  test('another client is another place to read from', async () => {
    aPageOfThree();
    const pinned = createRecordingClient();
    pinned.on('from "jit_test_users"', { rows: [userRow(idAt(20))] });
    await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await userRepo().findById(idAt(20), { orgId: ORG });
      await postgresRepo(users, { client: pinned }).findById(idAt(20), { orgId: ORG });
    });

    expect(client.statements).toHaveLength(2);
    expect(pinned.statements).toHaveLength(1);
  });

  test('a write to the entity is read back, never served from before it', async () => {
    aPageOfThree();
    client.on('update "jit_test_users"', { rows: [userRow(idAt(20), { name: 'renamed' })] });
    const after = await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await userRepo().findById(idAt(20), { orgId: ORG });
      await userRepo().update(idAt(20), { name: 'renamed' }, { orgId: ORG });
      return userRepo().findById(idAt(20), { orgId: ORG });
    });

    // page, preload, update, and the read the update forced.
    expect(client.statements).toHaveLength(4);
    expect(client.texts[3]).toContain('"id" in');
    expect(after?.name).toBe('U-20');
  });

  test('a write to another entity leaves this one preloaded', async () => {
    aPageOfThree();
    client.on('insert into "jit_test_posts"', { rows: [postRow(idAt(13), idAt(20))] });
    await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await userRepo().findById(idAt(20), { orgId: ORG });
      await postRepo().insert({ id: idAt(13), orgId: ORG, authorId: idAt(20), title: 'P-13' });
      await userRepo().findById(idAt(21), { orgId: ORG });
    });

    expect(client.statements).toHaveLength(3);
  });
});

describe('what a page never batches', () => {
  test('an id that is no page’s foreign key is the statement it always was', async () => {
    aPageOfThree();
    await inRequest(async () => {
      await userRepo().findById(idAt(90), { orgId: ORG });
      await userRepo().findById(idAt(91), { orgId: ORG });
    });

    expect(client.statements).toHaveLength(2);
    // One id each, and neither carries the page's authors: an id no page indexed reaches the
    // microtask batch, which a sequential pair of lookups never shares either.
    expect(client.statements[0]?.values).toEqual([idAt(90), ORG, 1]);
    expect(client.statements[1]?.values).toEqual([idAt(91), ORG, 1]);
  });

  test('with no request in scope a page leaves nothing behind', async () => {
    aPageOfThree();
    await authorsOfThePage();

    expect(client.statements).toHaveLength(4);
    expect(client.texts.slice(1).every((statement) => statement.includes('"id" = $1'))).toBe(true);
  });

  test('a page belongs to one request, so the next request reads for itself', async () => {
    aPageOfThree();
    await inRequest(() => postRepo().findMany({ orgId: ORG }));
    await inRequest(() => userRepo().findById(idAt(20), { orgId: ORG }));

    expect(client.statements).toHaveLength(2);
    // The id it was asked for, alone: the page's siblings died with the request that read them.
    expect(client.statements[1]?.values).toEqual([idAt(20), ORG, 1]);
  });

  test('a row that no longer decodes fails its own caller, not the page', async () => {
    aPageOfThree();
    // `name` is not-null, so a null from the database means the table no longer matches the
    // entity. That is this row's problem: the caller of the other id still gets their row.
    client.on('from "jit_test_users"', {
      rows: [userRow(idAt(20), { name: null }), userRow(idAt(21))],
    });
    await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await expect(userRepo().findById(idAt(20), { orgId: ORG })).rejects.toBeUltimateError(
        'X_INVARIANT_VIOLATED',
      );
      await expect(userRepo().findById(idAt(21), { orgId: ORG })).resolves.toHaveProperty(
        'name',
        'U-21',
      );
    });

    expect(client.statements).toHaveLength(2);
  });

  test('a preload that fails fails the caller it was widened for', async () => {
    aPageOfThree();
    const fail = (): Promise<never> => Promise.reject(new RangeError('boom'));
    const broken: DbClient = { query: fail, one: fail, execute: fail };
    await inRequest(async () => {
      await postRepo().findMany({ orgId: ORG });
      await expect(
        postgresRepo(users, { client: broken }).findById(idAt(20), { orgId: ORG }),
      ).rejects.toThrow('boom');
    });
  });
});
