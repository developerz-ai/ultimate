// What a subscriber's window does when one row changes: whether the row belongs, where it lands,
// and what leaves. Position is the guarantee under test — a patch placed anywhere but where the
// source would serve the row is an order no re-read returns and a cursor that skips what it was
// pushed past — alongside the identity a patch is addressed by, which no row may be missing.

import { describe, expect, test } from 'bun:test';
import type { ChangeEvent, Patch } from './matcher';
import { match } from './matcher';
import type { QueryShape } from './shape';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  /** Nullable and omissible: the two spellings of SQL NULL a live row arrives with. */
  readonly createdAt?: number | null;
  readonly score?: number | null;
}

const ORG = 'org-1';

const shape: QueryShape = {
  entity: 'posts',
  filters: [{ column: 'orgId', op: '=', value: ORG }],
  orderBy: [{ column: 'createdAt', direction: 'asc' }],
  limit: 3,
  unsupported: [],
};

const rows: readonly Post[] = [
  { id: 'a', orgId: 'org-1', createdAt: 10 },
  { id: 'b', orgId: 'org-1', createdAt: 20 },
];

const insert = (row: Post): ChangeEvent<Post> => ({ entity: 'posts', op: 'insert', row });

describe('incremental matcher', () => {
  test('an insert that enters the set produces an add at the right position', () => {
    const patches = match('feed', shape, rows, insert({ id: 'c', orgId: 'org-1', createdAt: 15 }));
    expect(patches).toEqual([
      { kind: 'add', position: 1, row: { id: 'c', orgId: 'org-1', createdAt: 15 } },
    ]);
  });

  test('an insert that misses the filter produces nothing', () => {
    const patches = match('feed', shape, rows, insert({ id: 'c', orgId: 'org-2', createdAt: 15 }));
    expect(patches).toEqual([]);
  });

  test('an insert into a full window evicts the tail', () => {
    const full: readonly Post[] = [...rows, { id: 'c', orgId: 'org-1', createdAt: 30 }];
    const patches = match('feed', shape, full, insert({ id: 'd', orgId: 'org-1', createdAt: 5 }));
    expect(patches.map((patch) => patch.kind)).toEqual(['add', 'remove']);
    expect(patches[0]).toMatchObject({ position: 0 });
    expect(patches[1]).toMatchObject({ id: 'c' });
  });

  test('an update that leaves the filter removes and asks for a refill', () => {
    // A FULL window on purpose: the tail only exists on the server once the client holds `limit`
    // rows, and that is the whole condition the refill is owed under.
    const full: readonly Post[] = [...rows, { id: 'c', orgId: 'org-1', createdAt: 30 }];
    const patches = match('feed', shape, full, {
      entity: 'posts',
      op: 'update',
      row: { id: 'b', orgId: 'org-2', createdAt: 20 },
    });
    expect(patches).toEqual([
      { kind: 'remove', position: 1, id: 'b' },
      { kind: 'refill', from: 2 },
    ]);
  });

  test('an update that only changes a non-ordering column patches in place', () => {
    const patches = match('feed', shape, rows, {
      entity: 'posts',
      op: 'update',
      row: { id: 'a', orgId: 'org-1', createdAt: 10 },
    });
    expect(patches).toEqual([
      { kind: 'update', position: 0, row: { id: 'a', orgId: 'org-1', createdAt: 10 } },
    ]);
  });

  test('another entity never touches this result set', () => {
    const patches = match('feed', shape, rows, {
      entity: 'comments',
      op: 'insert',
      row: { id: 'z', orgId: 'org-1', createdAt: 1 },
    });
    expect(patches).toEqual([]);
  });

  test('an unsupported shape throws X_MATCHER_UNSUPPORTED instead of guessing', () => {
    const aggregate: QueryShape = { ...shape, unsupported: ['group by'] };
    let code: unknown;
    try {
      match('feed', aggregate, rows, insert({ id: 'c', orgId: 'org-1', createdAt: 15 }));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_MATCHER_UNSUPPORTED');
  });
});

/** The index the first patch names — every kind but `refill` carries one. */
const positionOf = (patches: readonly Patch<Post>[]): number | undefined => {
  const first = patches[0];
  return first === undefined || first.kind === 'refill' ? undefined : first.position;
};

// A page is served `order by <declared keys>, "id" asc` and the cursor reads it the same way. The
// matcher is the third reader of that order: a row it puts anywhere else is a window the next
// re-read contradicts.
describe('the matcher places a row where the source would serve it', () => {
  const tied: readonly Post[] = [
    { id: 'b', orgId: ORG, createdAt: 10 },
    { id: 'c', orgId: ORG, createdAt: 10 },
  ];

  test('a row tied on every declared key is placed by its id, not appended after the group', () => {
    const patches = match('feed', shape, tied, insert({ id: 'a', orgId: ORG, createdAt: 10 }));
    expect(positionOf(patches)).toBe(0);
    expect(
      positionOf(match('feed', shape, tied, insert({ id: 'bb', orgId: ORG, createdAt: 10 }))),
    ).toBe(1);
  });

  test('a descending listing still breaks its ties on id ascending', () => {
    const desc: QueryShape = { ...shape, orderBy: [{ column: 'createdAt', direction: 'desc' }] };
    const patches = match('feed', desc, tied, insert({ id: 'a', orgId: ORG, createdAt: 10 }));
    expect(positionOf(patches)).toBe(0);
  });

  test('the position is the index the paged source returns the row at', async () => {
    const arrival: Post = { id: 'a', orgId: ORG, createdAt: 10 };
    const source = from<Post>('posts', [...tied, arrival])
      .where({ orgId: ORG })
      .orderBy('createdAt')
      .seek(null, 3);
    const served = await source.execute();
    expect(served.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(match('feed', source.shape(), tied, insert(arrival))).toEqual([
      { kind: 'add', position: 0, row: arrival },
    ]);
  });

  test('a null sort key lands last ascending and first descending', () => {
    const draft: Post = { id: 'z', orgId: ORG, createdAt: null };
    expect(positionOf(match('feed', shape, rows, insert(draft)))).toBe(2);
    const desc: QueryShape = { ...shape, orderBy: [{ column: 'createdAt', direction: 'desc' }] };
    const newest: readonly Post[] = [...rows].reverse();
    expect(positionOf(match('feed', desc, newest, insert(draft)))).toBe(0);
  });

  test('a column the row omits lands where an explicit null lands', () => {
    expect(positionOf(match('feed', shape, rows, insert({ id: 'z', orgId: ORG })))).toBe(2);
  });

  test('a row with no id is refused, never patched in as `String(undefined)`', () => {
    const nameless: object = { orgId: ORG, createdAt: 5 };
    let code: unknown;
    try {
      match<object>('feed', shape, rows, { entity: 'posts', op: 'insert', row: nameless });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_QUERY_NOT_PAGEABLE');
  });
});

// `where({ score: null })` is `"score" is null` in SQL, so it has to admit exactly the rows that
// predicate admits — and a comparison has to admit none of them.
describe('a change enters and leaves the set on SQL NULL semantics', () => {
  const drafts: QueryShape = {
    ...shape,
    filters: [{ column: 'score', op: '=', value: null }],
    orderBy: [],
  };

  test('`= null` admits a null column and refuses a value', () => {
    const draft: Post = { id: 'z', orgId: ORG, score: null };
    expect(match('feed', drafts, [], insert(draft))).toEqual([
      { kind: 'add', position: 0, row: draft },
    ]);
    expect(match('feed', drafts, [], insert({ id: 'y', orgId: ORG, score: 3 }))).toEqual([]);
  });

  test('scoring a draft takes it out of the set', () => {
    const held: readonly Post[] = [{ id: 'a', orgId: ORG, score: null }];
    const patches = match('feed', drafts, held, {
      entity: 'posts',
      op: 'update',
      row: { id: 'a', orgId: ORG, score: 9 },
    });
    // One row under a limit of three: the client held the whole result set, so the remove IS the
    // whole answer and no tail was lost.
    expect(patches).toEqual([{ kind: 'remove', position: 0, id: 'a' }]);
  });

  test('a comparison never admits a null column — unknown is not a match', () => {
    const scored: QueryShape = { ...drafts, filters: [{ column: 'score', op: '>', value: 5 }] };
    expect(match('feed', scored, [], insert({ id: 'z', orgId: ORG, score: null }))).toEqual([]);
    expect(match('feed', scored, [], insert({ id: 'z', orgId: ORG }))).toEqual([]);
    expect(match('feed', scored, [], insert({ id: 'z', orgId: ORG, score: 9 }))).toHaveLength(1);
  });
});

/**
 * A row that moves past the end of a FULL window. `insert()` places it among the `limit - 1` rows
 * the client still holds, so its position can never reach `shape.limit` and the `position >=
 * shape.limit` bail is unreachable on this path — the row was re-inserted INSIDE the window and
 * the client rendered a tail the server does not serve.
 */
describe('a move out of a full window is the server tail, not an add', () => {
  const ranked: QueryShape = {
    entity: 'posts',
    filters: [{ column: 'orgId', op: '=', value: ORG }],
    orderBy: [{ column: 'score', direction: 'asc' }],
    limit: 3,
    unsupported: [],
  };

  const window: readonly Post[] = [
    { id: 'a', orgId: ORG, score: 1 },
    { id: 'b', orgId: ORG, score: 2 },
    { id: 'c', orgId: ORG, score: 3 },
  ];

  const moved = (row: Post, before: Post): ChangeEvent<Post> => ({
    entity: 'posts',
    op: 'update',
    row,
    before,
  });

  test('sorting past every row the client holds asks the server for the tail', () => {
    // The server also holds `d: 4` and `e: 5`, which this client has never seen: the true window
    // after the move is `[b, c, d]`, and only a refill can say so.
    const patches = match(
      'feed',
      ranked,
      window,
      moved({ id: 'a', orgId: ORG, score: 99 }, { id: 'a', orgId: ORG, score: 1 }),
    );
    expect(patches).toEqual([
      { kind: 'remove', position: 0, id: 'a' },
      { kind: 'refill', from: 2 },
    ]);
  });

  test('a move that lands inside the window is still an add — nothing left the window', () => {
    const patches = match(
      'feed',
      ranked,
      window,
      moved({ id: 'a', orgId: ORG, score: 2.5 }, { id: 'a', orgId: ORG, score: 1 }),
    );
    expect(patches).toEqual([
      { kind: 'remove', position: 0, id: 'a' },
      { kind: 'add', position: 1, row: { id: 'a', orgId: ORG, score: 2.5 } },
    ]);
  });

  test('a window that was never full appends the row itself — there is no tail to ask for', () => {
    const partial = window.slice(0, 2);
    const patches = match(
      'feed',
      ranked,
      partial,
      moved({ id: 'a', orgId: ORG, score: 99 }, { id: 'a', orgId: ORG, score: 1 }),
    );
    expect(patches).toEqual([
      { kind: 'remove', position: 0, id: 'a' },
      { kind: 'add', position: 1, row: { id: 'a', orgId: ORG, score: 99 } },
    ]);
  });

  test('an unlimited window has no server tail either', () => {
    const patches = match(
      'feed',
      { ...ranked, limit: null },
      window,
      moved({ id: 'a', orgId: ORG, score: 99 }, { id: 'a', orgId: ORG, score: 1 }),
    );
    expect(patches).toEqual([
      { kind: 'remove', position: 0, id: 'a' },
      { kind: 'add', position: 2, row: { id: 'a', orgId: ORG, score: 99 } },
    ]);
  });
});

/**
 * `Patch.refill` means "the window lost a row and the tail is unknown to the client". A window the
 * source never filled to `limit` has no unknown tail — what the client holds IS the result set — so
 * a refill there is a claim the shape contradicts, and it costs the `remove` that rode in with it:
 * `matcher-bridge` folds any refill into `BridgeResult.refill`, and `live-fanout` then sends NO
 * patch frame that round and marks every subscriber desynced instead. On a quiet feed the deleted
 * row stays on screen until some other change to the same query id arrives.
 */
describe('a refill is only owed by a window that was full', () => {
  const short: readonly Post[] = [
    { id: 'a', orgId: ORG, createdAt: 10 },
    { id: 'b', orgId: ORG, createdAt: 20 },
  ];
  const full: readonly Post[] = [...short, { id: 'c', orgId: ORG, createdAt: 30 }];
  const remove = (row: Post): ChangeEvent<Post> => ({ entity: 'posts', op: 'delete', row });

  test('deleting from a window under the limit is a remove and nothing else', () => {
    expect(match('feed', shape, short, remove({ id: 'b', orgId: ORG, createdAt: 20 }))).toEqual([
      { kind: 'remove', position: 1, id: 'b' },
    ]);
  });

  test('deleting from a full window still asks the server for the tail', () => {
    expect(match('feed', shape, full, remove({ id: 'b', orgId: ORG, createdAt: 20 }))).toEqual([
      { kind: 'remove', position: 1, id: 'b' },
      { kind: 'refill', from: 2 },
    ]);
  });

  test('a wide limit over three rows names no position outside the result set', () => {
    // The reported reproduction: `limit: 50`, three rows held, delete `b`. The emitted
    // `{ kind: 'refill', from: 49 }` addressed row 49 of a two-row set.
    const wide: QueryShape = { ...shape, limit: 50 };
    expect(match('feed', wide, full, remove({ id: 'b', orgId: ORG, createdAt: 20 }))).toEqual([
      { kind: 'remove', position: 1, id: 'b' },
    ]);
  });

  test('a row leaving the filter follows the same rule as a delete', () => {
    const left: ChangeEvent<Post> = {
      entity: 'posts',
      op: 'update',
      row: { id: 'b', orgId: 'org-2', createdAt: 20 },
    };
    expect(match('feed', shape, short, left)).toEqual([{ kind: 'remove', position: 1, id: 'b' }]);
  });

  test('an unlimited window never asks for a tail it does not have', () => {
    const unlimited: QueryShape = { ...shape, limit: null };
    expect(match('feed', unlimited, full, remove({ id: 'a', orgId: ORG, createdAt: 10 }))).toEqual([
      { kind: 'remove', position: 0, id: 'a' },
    ]);
  });
});
