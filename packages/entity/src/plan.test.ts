// Single responsibility: pin `plan.ts` directly — the layer `memoryDriver()` and
// `postgresDriver()` both build a `QueryPlan` through, so a rule missing here is a rule the two
// drivers are free to disagree about (`repo.ts`, `pg-driver.ts` both call these, never their own
// copy). `repo.test.ts` and `pg-driver.test.ts` exercise this file indirectly through a repo; this
// file pins the plan-construction rules on their own — a total order, a bounded filter, a guarded
// write — without a driver in the way.

import { afterAll, describe, expect, test } from 'bun:test';
import { integer, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import type { EntityError } from './errors';
import {
  DEFAULT_PAGE_SIZE,
  deletePlan,
  idPlan,
  MAX_PAGE_SIZE,
  namedColumns,
  planFor,
  readPlan,
  singleKeyOf,
  totalOrder,
  updatePlan,
} from './plan';
import { clearRegistry } from './registry';

const posts = entity('plan_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text(),
    rank: integer(),
    deletedAt: timestamp().nullable(),
  },
});

const notes = entity('plan_notes', {
  columns: { id: uuid().primaryKey(), title: text() },
});

/** A composite key: `singleKeyOf` and the write guards need more than one column to prove out. */
const marks = entity('plan_marks', {
  columns: { postId: uuid(), memberId: uuid(), rank: integer() },
  primaryKey: ['postId', 'memberId'],
});

const ORG = '0192f5a0-0000-7000-8000-0000000000b0';
const ID = '0192f5a0-0000-7000-8000-00000000000a';

const caught = (run: () => unknown): EntityError | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as EntityError;
  }
};

afterAll(() => {
  clearRegistry();
});

describe('singleKeyOf', () => {
  test('a single-column primary key names its own column', () => {
    expect(singleKeyOf(posts, 'update')).toBe('id');
  });

  test('a composite primary key refuses, naming the write surfaces instead of a read', () => {
    const error = caught(() => singleKeyOf(marks, 'update'));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('updateWhere');
    expect(error?.cause).toContain('deleteWhere');
    expect(error?.cause).toContain('findMany');
  });
});

describe('totalOrder', () => {
  test('appends the primary key when the caller named no order at all', () => {
    expect(totalOrder(posts, [])).toEqual([{ column: 'id', direction: 'asc' }]);
  });

  test('appends the primary key after the caller order, never before it', () => {
    expect(totalOrder(posts, [{ column: 'rank', direction: 'asc' }])).toEqual([
      { column: 'rank', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  test('the tiebreak takes the LAST declared direction, never an unconditional asc', () => {
    // `rank desc, id asc` is a mixed-direction order, and `IndexInit.order` is ONE direction for
    // the whole index — so the order the driver sends could not be declared as an index in this
    // framework's own DSL, whatever the author wrote. It also costs the row-comparison seek:
    // measured on Postgres 16, `(rank, id) < ($1, $2)` is an Index Only Scan and the or-chain the
    // mixed order forces is a BitmapOr plus a Sort over the matched rows.
    expect(totalOrder(posts, [{ column: 'rank', direction: 'desc' }])).toEqual([
      { column: 'rank', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ]);
  });

  test('a mixed order is still reachable — the caller names the key itself', () => {
    expect(
      totalOrder(posts, [
        { column: 'rank', direction: 'desc' },
        { column: 'id', direction: 'asc' },
      ]),
    ).toEqual([
      { column: 'rank', direction: 'desc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  test('does not repeat a primary key column the caller already named', () => {
    expect(totalOrder(posts, [{ column: 'id', direction: 'desc' }])).toEqual([
      { column: 'id', direction: 'desc' },
    ]);
  });

  test('a composite primary key adds every column not already named', () => {
    expect(totalOrder(marks, [{ column: 'rank', direction: 'asc' }])).toEqual([
      { column: 'rank', direction: 'asc' },
      { column: 'postId', direction: 'asc' },
      { column: 'memberId', direction: 'asc' },
    ]);
  });
});

describe('planFor', () => {
  test('a tenant-scoped entity given orgId gets an eq predicate appended, not prepended', () => {
    const plan = planFor(posts, { where: [{ column: 'title', op: 'eq', value: 't' }], orgId: ORG });
    expect(plan.where).toEqual([
      { column: 'title', op: 'eq', value: 't' },
      { column: 'orgId', op: 'eq', value: ORG },
    ]);
  });

  test('no orgId given means no tenant predicate, whatever the entity declares', () => {
    expect(planFor(posts, {}).where).toEqual([]);
  });

  test('an unscoped entity ignores an orgId nobody could apply', () => {
    expect(planFor(notes, { orgId: ORG }).where).toEqual([]);
  });

  test('limit defaults, cursor and select are omitted rather than set to undefined', () => {
    const plan = planFor(posts, {});
    expect(plan.limit).toBe(50);
    expect('cursor' in plan).toBe(false);
    expect('select' in plan).toBe(false);
  });

  /**
   * The failure first: `limit` used to be carried verbatim, so `limit(input.pageSize)` on a number
   * that arrived over the wire bound whatever the client sent. `DEFAULT_PAGE_SIZE` bounded only
   * the read nobody sized — an explicitly named page had no ceiling, no integer check and no
   * positivity check, while `inBatches(size)` one file over had all three.
   */
  test('a page size nobody could have meant is refused, at the plan both drivers build', () => {
    const refused = (limit: number) => caught(() => planFor(posts, { limit }));
    expect(refused(5_000_000)).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(refused(MAX_PAGE_SIZE + 1)).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(refused(0)).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(refused(-1)).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(refused(2.5)).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(refused(Number.NaN)).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(refused(Number.POSITIVE_INFINITY)).toBeUltimateError('X_INVARIANT_VIOLATED');
    // The way out of it is the call that reads every row without holding them all.
    expect(String(refused(5_000_000)?.fix)).toContain('inBatches(1000)');
  });

  test('the ceiling itself, the default and one row all still build a plan', () => {
    expect(planFor(posts, { limit: MAX_PAGE_SIZE }).limit).toBe(MAX_PAGE_SIZE);
    expect(planFor(posts, { limit: 1 }).limit).toBe(1);
    expect(planFor(posts, {}).limit).toBe(DEFAULT_PAGE_SIZE);
  });

  test('a null cursor is treated the same as an absent one', () => {
    const plan = planFor(posts, { cursor: null });
    expect('cursor' in plan).toBe(false);
  });

  test('an explicit cursor and select both carry through', () => {
    const plan = planFor(posts, { cursor: 'c1', select: ['title'] });
    expect(plan.cursor).toBe('c1');
    expect(plan.select).toEqual(['title']);
  });

  test('orderBy always ends in the total order, primary key included', () => {
    expect(planFor(posts, { orderBy: [{ column: 'rank', direction: 'desc' }] }).orderBy).toEqual([
      { column: 'rank', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ]);
  });
});

describe('readPlan', () => {
  test('a tenant-scoped entity with no orgId is refused before any row is considered', () => {
    expect(caught(() => readPlan(posts, {}, 'findMany'))).toBeUltimateError('X_TENANCY_UNSCOPED');
  });

  test('an unscoped entity never needs an orgId', () => {
    expect(() => readPlan(notes, {}, 'findMany')).not.toThrow();
  });
});

describe('idPlan', () => {
  test('addresses exactly one row by the single primary key, limit 1', () => {
    const plan = idPlan(posts, ID, { orgId: ORG }, 'findById');
    expect(plan.where).toEqual([
      { column: 'id', op: 'eq', value: ID },
      { column: 'orgId', op: 'eq', value: ORG },
    ]);
    expect(plan.limit).toBe(1);
  });

  test('a tenant-scoped entity addressed with no orgId is refused, not answered as "not found"', () => {
    expect(caught(() => idPlan(posts, ID, undefined, 'findById'))).toBeUltimateError(
      'X_TENANCY_UNSCOPED',
    );
  });

  test('a composite-key entity refuses id addressing entirely', () => {
    expect(caught(() => idPlan(marks, ID, undefined, 'update'))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
  });
});

describe('namedColumns', () => {
  test('drops undefined properties so a forgotten variable never becomes a predicate', () => {
    expect(namedColumns({ a: 1, b: undefined, c: null })).toEqual([
      ['a', 1],
      ['c', null],
    ]);
  });

  test('a non-object value names nothing', () => {
    expect(namedColumns(null)).toEqual([]);
    expect(namedColumns('x')).toEqual([]);
  });
});

describe('deletePlan', () => {
  test('an empty filter is refused before tenancy even runs', () => {
    // No orgId either — if tenancy ran first this would throw X_TENANCY_UNSCOPED instead.
    const error = caught(() => deletePlan(posts, {}, undefined, 'deleteWhere'));
    expect(error).toBeUltimateError('X_WRITE_UNFILTERED');
  });

  test('an org predicate does not exempt a filtered delete from tenancy scoping', () => {
    expect(
      caught(() => deletePlan(posts, { title: 't' }, undefined, 'deleteWhere')),
    ).toBeUltimateError('X_TENANCY_UNSCOPED');
  });

  test('a bounded, scoped filter builds a plan with no page limit semantics attached', () => {
    const plan = deletePlan(posts, { title: 't' }, { orgId: ORG }, 'deleteWhere');
    expect(plan.where).toEqual([
      { column: 'title', op: 'eq', value: 't' },
      { column: 'orgId', op: 'eq', value: ORG },
    ]);
  });
});

describe('updatePlan', () => {
  test('an empty patch is refused even when the filter is bounded', () => {
    const error = caught(() => updatePlan(posts, { id: ID }, {}, { orgId: ORG }, 'updateWhere'));
    expect(error).toBeUltimateError('X_PATCH_EMPTY');
  });

  test('the filter guard still runs first — an empty filter wins over an empty patch', () => {
    const error = caught(() => updatePlan(posts, {}, {}, { orgId: ORG }, 'updateWhere'));
    expect(error).toBeUltimateError('X_WRITE_UNFILTERED');
  });

  test('a bounded filter and a named patch column both survive into the plan', () => {
    const plan = updatePlan(posts, { id: ID }, { title: 't2' }, { orgId: ORG }, 'updateWhere');
    expect(plan.where).toEqual([
      { column: 'id', op: 'eq', value: ID },
      { column: 'orgId', op: 'eq', value: ORG },
    ]);
  });
});

describe('an ordering no cursor can carry', () => {
  /**
   * `deletedAt` is nullable, and `null > 'x'` is unknown in SQL — so a keyset seek over it drops
   * rows from the middle of the listing. The refusal used to live in `cursorFor` alone, which runs
   * only when a page found one row past its limit: a table with fewer rows than the page size was
   * green forever and the first read past it in production was `X_INVARIANT_VIOLATED`. Whether an
   * ordering can carry a position is a property of the ORDER, not of how many rows happen to be
   * in the table, so it is decided where the plan is built.
   */
  test('an ordinary nullable column is NOT one — it orders, nulls last', () => {
    // The refusal used to fire here and made `order by published_at desc` unwritable in the query
    // language this framework documents, while `@ultimat3/query` had defined the ordering all
    // along. What the plan carries is the direction; where the NULLs go is `orderSql`'s.
    expect(
      planFor(posts, { orderBy: [{ column: 'deletedAt', direction: 'desc' }] }).orderBy,
    ).toEqual([
      { column: 'deletedAt', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ]);
  });

  test('an undeclared sort column is refused when the plan is built, at any row count', () => {
    expect(() =>
      planFor(posts, { orderBy: [{ column: 'nope', direction: 'desc' }], limit: 20 }),
    ).toThrow(/no column "nope"/);
  });

  test('is refused through readPlan too, so no driver can route around it', () => {
    expect(() =>
      readPlan(posts, { orderBy: [{ column: 'nope', direction: 'asc' }] }, 'findMany'),
    ).toThrow(/no column "nope"/);
  });

  test('a column the entity never declared is refused with it', () => {
    expect(() => planFor(posts, { orderBy: [{ column: 'nope', direction: 'asc' }] })).toThrow(
      /no column "nope"/,
    );
  });

  test('the default order — the primary key alone — is always seekable', () => {
    expect(planFor(posts, {}).orderBy).toEqual([{ column: 'id', direction: 'asc' }]);
  });
});
