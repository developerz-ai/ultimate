// Single responsibility: a name that came from a CALLER never resolves through `Object.prototype`.
// Every lookup table here is a plain object literal — the entity's `$columns`, the derived relation
// map, `cursor.ts`'s money parts — so `map['constructor']` answers the `Object` FUNCTION rather than
// `undefined`, every `=== undefined` refusal below it passes, and the next `.$meta.kind` is a bare
// `TypeError` where the caller was owed `X_INVARIANT_VIOLATED` naming the columns that exist.

import { afterAll, describe, expect, test } from 'bun:test';
import { upsertPlan } from './bulk-write';
import { money, text, timestamp, uuid } from './columns';
import { assertSeekable, cursorFor } from './cursor';
import { entity } from './entity';
import { physicalName } from './pg-row';
import { selectStatement } from './pg-sql';
import { clearRegistry } from './registry';
import { relationNamed } from './relations';
import { memoryRepo } from './repo';
import type { QueryPlan } from './tenancy';

/** The six names every object literal answers to without ever having been given one. */
const INHERITED = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
] as const;

const authors = entity('proto_test_authors', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

const items = entity('proto_test_items', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id),
    title: text({ max: 40 }),
    price: money(),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(() => {
  clearRegistry();
});

/** The error a synchronous refusal threw, so a coded throw asserts as a value like every other. */
const thrown = (work: () => unknown): unknown => {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
};

const planWith = (patch: Partial<QueryPlan>): QueryPlan => ({
  entity: items.$name,
  where: [],
  orderBy: [{ column: 'id', direction: 'asc' }],
  limit: 10,
  ...patch,
});

describe('a column name every object inherits is refused, never dereferenced', () => {
  test('physicalName() names the columns that exist instead of throwing a TypeError', () => {
    for (const name of INHERITED) {
      expect(thrown(() => physicalName(items, name))).toBeUltimateError('X_INVARIANT_VIOLATED');
    }
  });

  test('countBy() refuses one exactly as it refuses a typo', async () => {
    const repo = memoryRepo(items);
    for (const name of INHERITED) {
      await expect(repo.countBy(name)).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    }
    await expect(repo.countBy('nope')).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('an ordering by one cannot mint a cursor', () => {
    for (const name of INHERITED) {
      expect(thrown(() => assertSeekable(items, [{ column: name }]))).toBeUltimateError(
        'X_INVARIANT_VIOLATED',
      );
    }
  });

  // `MONEY_PARTS` is the second literal in `cursor.ts`: `price.toString` resolved to a function and
  // sailed past the `money === undefined` refusal, so `assertSeekable` minted a cursor for a sort
  // key no row carries and no page could seek from.
  test('a money PART every object inherits is refused too', () => {
    const plan = planWith({ orderBy: [{ column: 'price.toString', direction: 'asc' }] });
    const row = { id: 'x', price: { minor: 1, currency: 'USD' } };
    for (const part of INHERITED) {
      expect(thrown(() => assertSeekable(items, [{ column: `price.${part}` }]))).toBeUltimateError(
        'X_INVARIANT_VIOLATED',
      );
    }
    expect(thrown(() => cursorFor(items, plan, row, 'x'))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
  });

  test('an onConflict target of one is refused before the statement exists', () => {
    for (const name of INHERITED) {
      expect(thrown(() => upsertPlan(items, [{ title: 'a' }], [name], 'update'))).toBeUltimateError(
        'X_INVARIANT_VIOLATED',
      );
    }
  });

  test('a select of one narrows to nothing rather than reaching the SQL', () => {
    for (const name of INHERITED) {
      const statement = selectStatement(
        items,
        planWith({ select: [name] }),
        {
          includeDeleted: false,
        },
        10,
      );
      expect(statement.text).toContain('"id"');
      expect(statement.text).not.toContain(name);
    }
  });

  test('preloading one is X_PRELOAD_UNKNOWN_RELATION, never a Function as a Relation', () => {
    for (const name of INHERITED) {
      expect(thrown(() => relationNamed(items.$name, name))).toBeUltimateError(
        'X_PRELOAD_UNKNOWN_RELATION',
      );
    }
    // The relation that does exist still resolves — the guard refuses a name, not the lookup.
    expect(relationNamed(items.$name, 'author').kind).toBe('belongsTo');
  });
});
