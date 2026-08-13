// Pins the entity half of the one keyset cursor: what a page position is bound to (the plan that
// produced it), what survives the round trip (the column's kind), and what it refuses. The last
// case is the one the design exists for — the last row of a page deleted between two requests.

import { afterAll, describe, expect, test } from 'bun:test';
import { encodeCursor } from '@ultimat3/core';
import { boolean, integer, money, text, timestamp, uuid } from './columns';
import { assertSeekable, cursorFor, planScope, seekFrom, valueAt } from './cursor';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { QueryPlan, SortDirection, SortKey } from './tenancy';

const posts = entity('cursor_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    likeCount: integer().default(0),
    pinned: boolean().default(false),
    price: money(),
    publishedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
  },
});

type Post = typeof posts.$row;

const AT = new Date('2026-03-01T12:00:00.000Z');

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`;

/**
 * The largest minor unit a `Money` holds exactly. Big on purpose — a cursor that revived it
 * through a narrower path would round it, and so would the sort — but a `number`, because that
 * is what `MoneyValue.minor` is; `columns.test.ts` pins the refusal for anything past it.
 */
const MINOR = Number.MAX_SAFE_INTEGER;

/** `[column, direction]` pairs: the sort order is what these tests are about, not the shape. */
const by = (...keys: readonly (readonly [string, SortDirection])[]): readonly SortKey[] =>
  keys.map(([column, direction]) => ({ column, direction }));

const ROW: Post = {
  id: id(1),
  title: 'first',
  likeCount: 7,
  pinned: true,
  price: { minor: MINOR, currency: 'EUR' },
  publishedAt: null,
  createdAt: AT,
};

const BASE: QueryPlan = {
  entity: posts.$name,
  where: [{ column: 'likeCount', op: 'gte', value: 1 }],
  orderBy: by(['createdAt', 'asc'], ['id', 'asc']),
  limit: 20,
};

/** `toBeUltimateError` reads a value, and every refusal here throws synchronously. */
const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

afterAll(() => {
  clearRegistry();
});

describe('what a cursor is bound to', () => {
  test('the page size and the projection leave the scope alone', () => {
    // Asking for a bigger next page, or for fewer columns, is the same query over the same rows:
    // neither can move a row's position, so refusing the cursor would restart the client at one.
    expect(planScope({ ...BASE, limit: 500 })).toBe(planScope(BASE));
    expect(planScope({ ...BASE, select: ['id', 'title'] })).toBe(planScope(BASE));
  });

  test('the entity and every part of a filter change the scope', () => {
    // Each of these selects a different row set, so a position minted before the change names a
    // row the new query may not contain — the scope is what turns that into X_CURSOR_INVALID.
    const scope = planScope(BASE);
    expect(planScope({ ...BASE, entity: 'cursor_test_others' })).not.toBe(scope);
    expect(planScope({ ...BASE, where: [{ column: 'likeCount', op: 'gte', value: 2 }] })).not.toBe(
      scope,
    );
    expect(planScope({ ...BASE, where: [{ column: 'likeCount', op: 'gt', value: 1 }] })).not.toBe(
      scope,
    );
    expect(planScope({ ...BASE, where: [{ column: 'title', op: 'gte', value: 1 }] })).not.toBe(
      scope,
    );
  });

  test('the sort column and the sort direction change the scope', () => {
    // A flipped direction is the dangerous one: the keyset predicate still evaluates, so without
    // the scope the client would silently get the rows *before* its position instead of after it.
    const scope = planScope(BASE);
    expect(planScope({ ...BASE, orderBy: by(['title', 'asc'], ['id', 'asc']) })).not.toBe(scope);
    expect(planScope({ ...BASE, orderBy: by(['createdAt', 'desc'], ['id', 'asc']) })).not.toBe(
      scope,
    );
  });

  test('the same predicate set built in two orders is one scope', () => {
    // `and` is commutative: `where(a).andWhere(b)` and `where(b).andWhere(a)` are the same query,
    // and a client that reordered its filters must not be handed a cursor error for it.
    const forwards: QueryPlan = {
      ...BASE,
      where: [
        { column: 'likeCount', op: 'gte', value: 1 },
        { column: 'title', op: 'like', value: 'a%' },
      ],
    };
    const backwards: QueryPlan = { ...forwards, where: [...forwards.where].reverse() };
    expect(planScope(backwards)).toBe(planScope(forwards));
  });
});

describe('the round trip', () => {
  test('each sort value comes back as the type its column holds', () => {
    // A cursor is text on the wire; seeking compares it against live rows, so a `Date` that came
    // back as a string — or a boolean as `'false'` — would order rows by a type Postgres never had.
    const plan: QueryPlan = {
      ...BASE,
      orderBy: by(
        ['createdAt', 'asc'],
        ['likeCount', 'asc'],
        ['pinned', 'asc'],
        ['title', 'asc'],
        ['id', 'asc'],
      ),
    };
    const [when, likes, pinned, title, key] =
      seekFrom(posts, { ...plan, cursor: cursorFor(posts, plan, ROW, ROW.id) }) ?? [];

    expect(when).toBeInstanceOf(Date);
    expect(when instanceof Date ? when.getTime() : null).toBe(AT.getTime());
    expect(likes).toBe(7);
    expect(pinned).toBe(true);
    expect(title).toBe('first');
    expect(key).toBe(ROW.id);

    // `'false'` is a truthy string: revived by truthiness the two rows would sort together.
    const [, , unpinned] =
      seekFrom(posts, {
        ...plan,
        cursor: cursorFor(posts, plan, { ...ROW, pinned: false }, ROW.id),
      }) ?? [];
    expect(unpinned).toBe(false);
  });

  test('money rides as its two parts — minor as a number, currency as text', () => {
    // Money is one property over two physical columns, so a sort path names the part. `minor`
    // revives as the kind the ROW holds (a number), not as the physical column's `bigint`: a
    // cursor value of the wrong type compares against the property it is seeking past.
    const plan: QueryPlan = {
      ...BASE,
      orderBy: by(['price.minor', 'asc'], ['price.currency', 'asc'], ['id', 'asc']),
    };
    expect(valueAt(ROW, 'price.minor')).toBe(MINOR);

    const [minor, currency] =
      seekFrom(posts, { ...plan, cursor: cursorFor(posts, plan, ROW, ROW.id) }) ?? [];
    expect(minor).toBe(MINOR);
    expect(typeof minor).toBe('number');
    expect(currency).toBe('EUR');
  });

  test('a plan with no cursor seeks from nowhere, not from an empty position', () => {
    // `[]` is not "the beginning": it compares equal to every row, so the driver would find no row
    // after it and hand back an empty first page. Absence has to stay absent.
    expect(seekFrom(posts, BASE)).toBeUndefined();
  });
});

describe('the refusals', () => {
  test('a hand-edited signature is X_CURSOR_INVALID', () => {
    // Derive the flipped character from the one already there: writing a fixed character over an
    // equal one is not a tamper at all, and the test would then pass for no reason.
    const cursor = cursorFor(posts, BASE, ROW, ROW.id);
    const dot = cursor.lastIndexOf('.');
    const signature = cursor.slice(dot + 1);
    const forged = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    const tampered = `${cursor.slice(0, dot)}.${forged}`;

    expect(caught(() => seekFrom(posts, { ...BASE, cursor: tampered }))).toBeUltimateError(
      'X_CURSOR_INVALID',
    );
  });

  test('a cursor from another filter or another sort direction is refused', () => {
    // Never a silent page one: the client would page a window it never asked for and would have
    // no way to tell that from real data.
    const cursor = cursorFor(posts, BASE, ROW, ROW.id);
    const filtered: QueryPlan = {
      ...BASE,
      cursor,
      where: [{ column: 'likeCount', op: 'gte', value: 2 }],
    };
    const flipped: QueryPlan = {
      ...BASE,
      cursor,
      orderBy: by(['createdAt', 'desc'], ['id', 'asc']),
    };

    expect(caught(() => seekFrom(posts, filtered))).toBeUltimateError('X_CURSOR_INVALID');
    expect(caught(() => seekFrom(posts, flipped))).toBeUltimateError('X_CURSOR_INVALID');
  });

  test('a cursor whose arity does not match the sort order is X_CURSOR_INVALID', () => {
    // Signed and in scope, so it reaches the arity guard. The alternative to the guard is a
    // missing value read as `''`, which is a position every row in the table is "after".
    const cursor = encodeCursor({ scope: planScope(BASE), key: [AT.toISOString()], id: ROW.id });
    expect(caught(() => seekFrom(posts, { ...BASE, cursor }))).toBeUltimateError(
      'X_CURSOR_INVALID',
    );
  });

  test('a nullable sort column cannot carry a cursor, and the fix names the key to use', () => {
    // `null > 'x'` is unknown in SQL, so a nullable key drops rows out of the middle of a listing.
    // The message has to name the primary key, or the reader has nothing to order by instead.
    const error = caught(() => assertSeekable(posts, [{ column: 'publishedAt' }]));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error instanceof Error ? error.message : '').toContain(".orderBy('id')");
    expect(caught(() => assertSeekable(posts, [{ column: 'createdAt' }]))).toBeUndefined();
  });

  test('a column the entity never declared, and a money part that is not one, are refused', () => {
    // A sort key is resolved through the entity, never trusted from the plan: an unknown column
    // would otherwise read `undefined` off every row and order the whole page arbitrarily.
    expect(caught(() => assertSeekable(posts, [{ column: 'nope' }]))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );

    // Refused when the cursor is MINTED, not one page later: `cursorFor` asserts the same rule
    // `seekFrom` does, so an ordering nothing can decode never reaches a client at all.
    const plan: QueryPlan = { ...BASE, orderBy: by(['price.bogus', 'asc']) };
    expect(caught(() => cursorFor(posts, plan, ROW, ROW.id))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
  });

  test('money named without a part is refused instead of riding as "[object Object]"', () => {
    // `String({ minor, currency })` in a cursor comes back as a bare SyntaxError from `BigInt` —
    // no code, no fix — one page after the mistake. `entity()` refuses the same path in resolve().
    const plan: QueryPlan = { ...BASE, orderBy: by(['price', 'asc']) };
    const error = caught(() => cursorFor(posts, plan, ROW, ROW.id));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error instanceof Error ? error.message : '').toContain('price.minor');
  });
});

describe('the page after the row it pointed at was deleted', () => {
  const seed = async () => {
    const db = database({ posts }, { driver: memoryDriver() });
    for (let index = 0; index < 5; index += 1) {
      await db.posts.insert({
        id: id(index),
        title: `post ${index}`,
        likeCount: index,
        pinned: false,
        price: { minor: BigInt(index), currency: 'EUR' },
        publishedAt: null,
        createdAt: new Date(AT.getTime() + index * 1000),
      });
    }
    return db;
  };

  test('the next page continues from the position, not from the row', async () => {
    // The whole reason the cursor carries the sort VALUES and not just an id: seeking by an id
    // that is gone finds nothing, and pagination silently restarts at the top — the client then
    // sees rows it already has and never reaches the end.
    const db = await seed();
    const feed = () => db.posts.orderBy('likeCount').limit(2);

    const first = await feed().page();
    expect(first.rows.map((row) => row.id)).toEqual([id(0), id(1)]);

    await db.posts.delete(id(1));
    const second = await feed().after(first.nextCursor).page();

    expect(second.rows.map((row) => row.id)).toEqual([id(2), id(3)]);
  });
});
