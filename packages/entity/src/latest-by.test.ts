// What `latestBy` answers — the newest row per group, ties by the key, refusals — against the
// in-memory driver's fold (`memory-latest-by.ts`) and the paged fallback a repository without the
// method gets (`latestRows`), which must agree row for row. The wire side is
// `latest-by-sql.test.ts`; the server's own answer is `latest-by.live.test.ts`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { integer, text, timestamp, uuid } from './columns';
import { kindOf, valueAt } from './cursor';
import { entity } from './entity';
import { EntityError } from './errors';
import { type LatestBySpec, latestByRows, latestRows, MAX_LATEST_GROUPS } from './latest-by';
import { memoryLatestBy } from './memory-latest-by';
import { compareByKind, matchesPredicate } from './memory-match';
import { memoryRepo } from './memory-repo';
import { readPlan } from './plan';
import { clearRegistry } from './registry';
import type { FindManyArgs, Repo } from './repo';

const messages = entity('latest_by_test_messages', {
  columns: {
    id: uuid().primaryKey(),
    conversationId: uuid(),
    body: text({ max: 40 }),
    seq: integer(),
    sentAt: timestamp(),
    deletedAt: timestamp().nullable(),
  },
});

type Message = (typeof messages)['$row'];

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const conversation = (group: number): string => idAt(10_000 + group);
const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 11, 9, minute));

/** 20 conversations × 3 messages; in each, two share the newest minute — the tie the key breaks. */
const seed = (): Message[] =>
  Array.from({ length: 20 }, (_, group) =>
    [0, 1, 2].map((n) =>
      messages.$parse({
        id: idAt(group * 10 + n),
        conversationId: conversation(group),
        body: `c${group} m${n}`,
        seq: n,
        sentAt: at(n === 0 ? 1 : 5),
        deletedAt: null,
      }),
    ),
  ).flat();

/** The memory driver's own `select`, minus its store: the plan built and guarded, rows matched and sorted. */
const selectOver = (rows: readonly Message[]) => (args: FindManyArgs, op: string) => {
  const plan = readPlan(messages, args, op);
  const found = rows
    .filter((row) => plan.where.every((p) => matchesPredicate(messages, row, p)))
    .filter((row) => args.includeDeleted === true || row.deletedAt === null)
    .sort((left, right) => {
      for (const key of plan.orderBy) {
        const order = compareByKind(
          kindOf(messages, key.column),
          valueAt(left, key.column),
          valueAt(right, key.column),
        );
        if (order !== 0) return key.direction === 'desc' ? -order : order;
      }
      return 0;
    });
  return { plan, found };
};

/** The in-memory driver's fold. */
const foldedOver = (rows: readonly Message[]): Repo<Message> =>
  ({
    ...memoryRepo(messages, [...rows]),
    ...memoryLatestBy(messages, selectOver(rows)),
  }) as Repo<Message>;

/** No `latestBy` of its own: `latestRows` pages `findMany` and folds. */
const fallbackOver = (rows: readonly Message[]): Repo<Message> => {
  const { latestBy: _own, ...repo } = memoryRepo(messages, [...rows]);
  return repo;
};

let rows: Message[];
let folded: Repo<Message>;
let fallback: Repo<Message>;

beforeEach(() => {
  rows = seed();
  folded = foldedOver(rows);
  fallback = fallbackOver(rows);
});

afterAll(() => {
  clearRegistry();
});

const ids = (found: readonly unknown[]): readonly unknown[] =>
  found.map((row) => valueAt(row, 'id'));

const newest: LatestBySpec = {
  group: 'conversationId',
  order: [{ column: 'sentAt', direction: 'desc' }],
  perGroup: 1,
};

describe.each([
  ['the memory fold', foldedOver],
  ['the paged fallback', fallbackOver],
])('%s', (_name, over) => {
  const repoOf = () => over(rows);

  test('20 groups: one row each, the newest, a tie broken by the key in the same direction', async () => {
    const found = await latestRows(messages, repoOf(), newest);

    expect(found).toHaveLength(20);
    // m1 and m2 share the newest minute; the key descending picks m2.
    expect(ids(found)).toEqual(Array.from({ length: 20 }, (_, group) => idAt(group * 10 + 2)));
  });

  test('ascending order is the oldest row; an empty order is the key descending', async () => {
    const oldest = await latestRows(messages, repoOf(), {
      ...newest,
      order: [{ column: 'seq', direction: 'asc' }],
    });
    expect(ids(oldest).slice(0, 2)).toEqual([idAt(0), idAt(10)]);

    const byKey = await latestRows(messages, repoOf(), { ...newest, order: [] });
    expect(ids(byKey).slice(0, 2)).toEqual([idAt(2), idAt(12)]);
  });

  test('keys: n rows per named group, grouped, newest first; other groups absent', async () => {
    const found = await latestRows(messages, repoOf(), {
      ...newest,
      perGroup: 2,
      keys: [conversation(3), conversation(7)],
    });

    expect(ids(found)).toEqual([idAt(32), idAt(31), idAt(72), idAt(71)]);
  });

  test("the chain's predicate and soft delete scope it, as they scope a page", async () => {
    rows[2] = { ...(rows[2] as Message), deletedAt: at(9) };
    const found = await latestRows(messages, repoOf(), newest, {
      where: [{ column: 'conversationId', op: 'in', value: [conversation(0), conversation(1)] }],
    });

    // Group 0's newest is deleted: the next one stands in.
    expect(ids(found)).toEqual([idAt(1), idAt(12)]);
  });
});

describe('the refusals', () => {
  const refusal = async (run: () => Promise<unknown>): Promise<EntityError> => {
    try {
      await run();
    } catch (error) {
      if (error instanceof EntityError) return error;
      throw error;
    }
    return expect.unreachable('expected an EntityError');
  };

  test('a group column a row cannot be filed under is refused in both paths', async () => {
    for (const repo of [folded, fallback]) {
      const error = await refusal(() => latestRows(messages, repo, { ...newest, group: 'sentAt' }));
      expect(error.code).toBe('X_INVARIANT_VIOLATED');
      expect(error.message).toContain('latestBy');
    }
  });

  test('more than one row per group without naming the groups is refused', async () => {
    const error = await refusal(() => latestRows(messages, folded, { ...newest, perGroup: 3 }));
    expect(error.code).toBe('X_INVARIANT_VIOLATED');
    expect(error.fix).toContain('perParent');
  });

  test('past the group bound it is refused, never truncated', async () => {
    const many = Array.from({ length: MAX_LATEST_GROUPS + 1 }, (_, group) =>
      messages.$parse({
        id: idAt(100_000 + group),
        conversationId: idAt(200_000 + group),
        body: 'x',
        seq: 0,
        sentAt: at(1),
        deletedAt: null,
      }),
    );
    for (const repo of [foldedOver(many), fallbackOver(many)]) {
      const error = await refusal(() => latestRows(messages, repo, newest));
      expect(error.message).toContain(`more than ${MAX_LATEST_GROUPS} groups`);
    }
  });

  test("the chain's orderBy, limit and after are refused by name", async () => {
    const error = await refusal(() =>
      latestByRows(
        messages,
        folded,
        'conversationId',
        { order: 'sentAt' },
        {
          orderBy: [{ column: 'seq', direction: 'asc' }],
          limit: 5,
        },
      ),
    );
    expect(error.message).toContain('orderBy(), limit()');
  });

  test('the chain terminal is descending unless stated', async () => {
    const found = await latestByRows(messages, folded, 'conversationId', { order: 'seq' }, {});
    expect(ids(found).slice(0, 1)).toEqual([idAt(2)]);
    const first = await latestByRows(
      messages,
      folded,
      'conversationId',
      { order: 'seq', direction: 'asc' },
      {},
    );
    expect(ids(first).slice(0, 1)).toEqual([idAt(0)]);
  });
});
