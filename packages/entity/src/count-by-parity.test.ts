// The two drivers of a grouped count, side by side: the answer they must agree on, the refusals
// they must share, and the bound that refuses rather than truncates. A recording client stands in
// for the server, `memoryRepo` is the other half, and both are compared against rows written out
// by hand so neither can be right only because the other is wrong. The SQL a chain compiles to is
// `count-by-statements.test.ts`'s subject — this file is about the answer, never the text.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { column } from './column';
import { integer, money, text, timestamp, uuid } from './columns';
import { MAX_GROUPS } from './count-by';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Column } from './types';

/**
 * `bigint` and `jsonb` are `ColumnKind` members no builder in `columns.ts` spells — one groupable,
 * one refused — so both are built from the same `column()` helper every public builder is made of.
 * `count-by.ts` branches on the kind, and a kind with no test is a branch nothing runs.
 */
const bigints = (): Column<bigint> =>
  column<bigint>('bigint', (value) => (typeof value === 'bigint' ? value : BigInt(String(value))));

const jsonb = (): Column<unknown> => column<unknown>('jsonb', (value) => value);

const orgs = entity('count_parity_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

/**
 * One row per reaction — the shape `countBy` exists for: `likes.countBy('postId')` in place of one
 * `count()` per post. Every kind the groupable set turns on or refuses is declared once here, and
 * `count` is among them because an entity is free to name a column after the aggregate.
 */
const likes = entity('count_parity_likes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    postId: uuid().nullable(),
    reaction: text({ max: 20 }),
    count: integer(),
    weight: bigints(),
    payload: jsonb(),
    total: money(),
    createdAt: timestamp().defaultNow(),
    deletedAt: timestamp().nullable(),
  },
});

/**
 * Every column a `Map` cannot be keyed by and nothing else — a `timestamptz` is a legal primary
 * key, so an entity really can offer a grouped count no column of it could answer. The one shape
 * that reaches the branch where the refusal has no call to suggest.
 */
const ungroupable = entity('count_parity_ungroupable', {
  columns: { at: timestamp().primaryKey(), payload: jsonb(), total: money() },
});

type Like = typeof likes.$row;

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;

const ORG = idAt('a1');
const OTHER_ORG = idAt('a2');
const POST_A = idAt('aaa');
const POST_B = idAt('bbb');
const POST_C = idAt('ccc');

const like = (index: number, over: Partial<Like> = {}): Like => ({
  id: idAt(String(index)),
  orgId: ORG,
  postId: POST_A,
  reaction: 'like',
  count: 1,
  weight: 10n,
  payload: {},
  total: { minor: 0, currency: 'EUR' },
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  deletedAt: null,
  ...over,
});

/**
 * One tenant's rows — three on post A, two each on B, C and on no post at all — then a stamped row
 * and another tenant's row, both on post A, so 4 or 5 there is the only reading either leak could
 * produce. The group rows below are what a server answers for exactly these, written out rather
 * than derived, so the two drivers are compared against a third thing and not against each other.
 */
const SEED: readonly Like[] = [
  ...[POST_A, POST_A, POST_A, POST_B, POST_B, POST_C, POST_C, null, null].map((postId, index) =>
    like(index, { postId }),
  ),
  like(90, { deletedAt: new Date('2026-02-02T00:00:00.000Z') }),
  like(91, { orgId: OTHER_ORG }),
];

/** What Postgres answers for `SEED` under `ORG` — in an order the map must not keep. */
const VISIBLE_GROUPS = [
  { group_value: POST_C, group_count: '2' },
  { group_value: null, group_count: '2' },
  { group_value: POST_A, group_count: '3' },
  { group_value: POST_B, group_count: '2' },
];

/** The same, with the soft-delete clause dropped: post A gains the stamped row and nothing else. */
const WITH_DELETED_GROUPS = [
  { group_value: POST_B, group_count: '2' },
  { group_value: POST_A, group_count: '4' },
  { group_value: null, group_count: '2' },
  { group_value: POST_C, group_count: '2' },
];

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const repo = () => postgresRepo(likes);
const memory = (seed: readonly Like[] = SEED) => memoryRepo(likes, seed);
const lastText = (): string => client.texts.at(-1) ?? '';
const lastValues = (): readonly unknown[] => client.statements.at(-1)?.values ?? [];

type Refusal = Record<'code' | 'cause' | 'fix', string>;

/** What a refusal says. A code is the contract, and a `fix:` that names no edit is not one. */
const refusal = async (call: Promise<unknown>): Promise<Refusal> => {
  try {
    await call;
    return { code: 'resolved', cause: '', fix: '' };
  } catch (error) {
    if (!isUltimateError(error)) return { code: String(error), cause: '', fix: '' };
    return { code: error.code, cause: error.cause, fix: error.fix };
  }
};

/** Distinct groups, in the shape Bun.SQL hands them over: an int8 count is a string. */
const groupRows = (howMany: number): readonly Record<string, unknown>[] =>
  Array.from({ length: howMany }, (_, index) => ({
    group_value: idAt(String(index)),
    group_count: String((index % 7) + 1),
  }));

describe('the bound refuses rather than truncates', () => {
  test('one group past the bound is an error, not a map missing its tail', async () => {
    client.on('group by', { rows: groupRows(MAX_GROUPS + 1) });

    await expect(repo().countBy('postId', { orgId: ORG })).rejects.toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    // One group more than the bound, on purpose: that extra group is the whole signal, and a
    // `limit MAX_GROUPS` would make a complete answer and a truncated one read identically.
    expect(lastValues().at(-1)).toBe(MAX_GROUPS + 1);
  });

  test('exactly the bound resolves, whole', async () => {
    client.on('group by', { rows: groupRows(MAX_GROUPS) });

    const counts = await repo().countBy('postId', { orgId: ORG });

    expect(counts.size).toBe(MAX_GROUPS);
    expect([...counts.values()][0]).toBe(7);
    expect(counts.get(idAt('0'))).toBe(1);
  });

  test('the in-memory driver refuses at the same bound, from the same function', async () => {
    // The bound belongs to `count-by.ts`, not to the statement: 1001 distinct values held in
    // memory is the same refusal, and a bound that lived in `limit` alone would let this through.
    const many = Array.from({ length: MAX_GROUPS + 1 }, (_, index) =>
      like(index, { postId: idAt(`p${index}`) }),
    );

    await expect(memory(many).countBy('postId', { orgId: ORG })).rejects.toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    // One distinct value fewer and it resolves, so the refusal above is about the bound and not
    // about the size of the seed.
    expect((await memory(many.slice(0, MAX_GROUPS)).countBy('postId', { orgId: ORG })).size).toBe(
      MAX_GROUPS,
    );
  });
});

describe('the refusals both drivers share', () => {
  const UNGROUPABLE: readonly (readonly [string, string])[] = [
    ['secret', 'no column "secret" on count_parity_likes'],
    ['createdAt', 'a timestamptz column is not a key a map can be looked up by'],
    ['payload', 'a jsonb column is not a key a map can be looked up by'],
    ['total', 'a money column is not a key a map can be looked up by'],
  ];

  test('an ungroupable column is the same refusal in both drivers, before any statement', async () => {
    for (const [property, cause] of UNGROUPABLE) {
      const fromPostgres = await refusal(repo().countBy(property, { orgId: ORG }));
      const fromMemory = await refusal(memory().countBy(property, { orgId: ORG }));

      expect(fromPostgres.code).toBe('X_INVARIANT_VIOLATED');
      // Byte for byte, because ONE function raised both: a driver growing its own copy of this
      // rule is the drift `count-by.ts` exists to prevent, and it would surface here first.
      expect(fromPostgres).toEqual(fromMemory);
      expect(fromPostgres.cause).toContain(`count_parity_likes.countBy('${property}'): ${cause}`);
    }
    expect(client.statements).toHaveLength(0);
  });

  test('the column is judged before the scope is', async () => {
    // `groupColumnOf` runs ahead of `readPlan` in both drivers, so an author who named the wrong
    // column is told about the column — not about a tenancy predicate they would then add for
    // nothing and still be refused.
    expect((await refusal(repo().countBy('createdAt'))).code).toBe('X_INVARIANT_VIOLATED');
    expect((await refusal(memory().countBy('createdAt'))).code).toBe('X_INVARIANT_VIOLATED');
    expect(client.statements).toHaveLength(0);
  });

  test('the refusal names a column of this entity that would have worked', async () => {
    const refused = await refusal(repo().countBy('createdAt', { orgId: ORG }));

    // Not `x entity explain`: what repairs this is one edit to the call, and the replacement
    // column can only be named by reading the entity.
    expect(refused.fix).toBe(
      "count_parity_likes.countBy('id')   # group by one of: id, orgId, postId, reaction, count, weight",
    );
  });

  test('an entity with nothing to group by is told to read it, since no call would work', async () => {
    // The one branch where a `fix:` cannot be a call: every column here would be refused the same
    // way, so it names a command that exists (`x entities describe`, which prints the kinds) rather
    // than suggesting a `countBy` that fails identically.
    const refused = await refusal(memoryRepo(ungroupable).countBy('at'));

    expect(refused.code).toBe('X_INVARIANT_VIOLATED');
    expect(refused.fix).toBe(
      'x entities describe count_parity_ungroupable --json   # this entity declares no column a count can be keyed by',
    );
  });
});

describe('two drivers, one meaning', () => {
  test('the same rows produce the same map, in the same order, in both drivers', async () => {
    client.on('group by', { rows: VISIBLE_GROUPS });

    const fromPostgres = await repo().countBy('postId', { orgId: ORG });
    const fromMemory = await memory().countBy('postId', { orgId: ORG });

    expect([...fromPostgres]).toEqual([...fromMemory]);
    // And both against a third thing, so neither can be right only because the other is wrong.
    expect([...fromMemory]).toEqual([
      [POST_A, 3],
      [POST_B, 2],
      [POST_C, 2],
      [null, 2],
    ]);
    // The stamped row and the other tenant's row both sit on post A.
    expect(fromMemory.get(POST_A)).toBe(3);
  });

  test('includeDeleted is the same one extra row in both drivers', async () => {
    client.on('group by', { rows: WITH_DELETED_GROUPS });

    const args = { orgId: ORG, includeDeleted: true };
    const fromPostgres = await repo().countBy('postId', args);
    // Postgres does it by dropping a clause, memory by skipping a filter — same answer.
    expect(lastText()).not.toContain('"deleted_at" is null');

    const fromMemory = await memory().countBy('postId', args);

    expect([...fromPostgres]).toEqual([...fromMemory]);
    expect(fromMemory.get(POST_A)).toBe(4);
  });

  test('another tenant is a different breakdown, never a shared one', async () => {
    const ours = await memory().countBy('postId', { orgId: ORG });
    const theirs = await memory().countBy('postId', { orgId: OTHER_ORG });

    expect(ours.get(POST_A)).toBe(3);
    expect([...theirs]).toEqual([[POST_A, 1]]);

    // The Postgres driver carries that same scope into the statement rather than filtering rows
    // it has already read, which is the only way it can mean the same thing.
    await repo().countBy('postId', { orgId: OTHER_ORG });
    expect(lastText()).toContain('"org_id" = $1');
    expect(lastValues()[0]).toBe(OTHER_ORG);
  });

  test('a bounded breakdown narrows both drivers the same way', async () => {
    // The shape the too-many-groups refusal tells an author to write: bound the values, then
    // count them in one statement.
    const args = {
      orgId: ORG,
      where: [{ column: 'postId', op: 'in' as const, value: [POST_B, POST_C] }],
    };
    client.on('group by', {
      rows: [
        { group_value: POST_C, group_count: '2' },
        { group_value: POST_B, group_count: '2' },
      ],
    });

    const fromPostgres = await repo().countBy('postId', args);
    expect(lastText()).toContain('"post_id" in ($1, $2)');

    const fromMemory = await memory().countBy('postId', args);

    expect([...fromPostgres]).toEqual([...fromMemory]);
    expect([...fromMemory]).toEqual([
      [POST_B, 2],
      [POST_C, 2],
    ]);
  });

  test('a page bounds a page, never a count: limit() and after() reach neither driver', async () => {
    // An aggregate covers the predicate — the chain's filters, its tenancy, its soft-delete
    // visibility — and never the page. A cursor that reached one driver and not the other would
    // make the breakdown change as the caller paged through it.
    const args = { orgId: ORG } as const;
    const { nextCursor } = await memory().findMany({ ...args, limit: 2 });
    expect(nextCursor).not.toBeNull();
    const paged = { ...args, limit: 2, cursor: nextCursor };
    client.on('group by', { rows: VISIBLE_GROUPS });

    const fromPostgres = await repo().countBy('postId', paged);
    // The only limit in the statement is the group bound, and no seek term made it in.
    expect(lastValues().at(-1)).toBe(MAX_GROUPS + 1);
    expect(lastText()).not.toContain('>');

    const fromMemory = await memory().countBy('postId', paged);

    expect([...fromPostgres]).toEqual([...fromMemory]);
    expect([...fromMemory]).toEqual([...(await memory().countBy('postId', args))]);
    // `count()` is the same rule with one group, and it is the one both are compared against.
    expect(await memory().count(paged)).toBe(await memory().count(args));
  });

  test('a predicate nothing matches is an empty map in both drivers, never a map of zeros', async () => {
    const args = { orgId: ORG, where: [{ column: 'reaction', op: 'eq' as const, value: 'nope' }] };

    const fromPostgres = await repo().countBy('postId', args);
    const fromMemory = await memory().countBy('postId', args);

    expect([...fromPostgres]).toEqual([]);
    expect([...fromMemory]).toEqual([]);
    // Absent, so the caller can still tell "none" from "never asked" — the `?? 0` is theirs.
    expect(fromMemory.get(POST_A)).toBeUndefined();
  });
});
