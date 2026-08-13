// The grouped count against a recording client: the one statement `countBy` compiles to, and what
// an int8, a group key and a NULL decode into on the way back. Statement text is exactly what a
// live server cannot be asked, which is why it is asserted here; the answer the two drivers must
// agree on, their shared refusals and the group bound are `count-by-parity.test.ts`'s subject.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { column } from './column';
import { integer, money, text, timestamp, uuid } from './columns';
import { MAX_GROUPS } from './count-by';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';
import type { Column } from './types';

/**
 * `bigint` and `jsonb` are `ColumnKind` members no builder in `columns.ts` spells — one groupable,
 * one refused — so both are built from the same `column()` helper every public builder is made of.
 * `count-by.ts` branches on the kind, and a kind with no test is a branch nothing runs.
 */
const bigints = (): Column<bigint> =>
  column<bigint>('bigint', (value) => (typeof value === 'bigint' ? value : BigInt(String(value))));

const jsonb = (): Column<unknown> => column<unknown>('jsonb', (value) => value);

const orgs = entity('count_test_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

/**
 * One row per reaction — the shape `countBy` exists for: `likes.countBy('postId')` in place of one
 * `count()` per post. Every kind the groupable set turns on or refuses is declared once here, and
 * `count` is among them because an entity is free to name a column after the aggregate.
 */
const likes = entity('count_test_likes', {
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

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;

const ORG = idAt('a1');
const POST_A = idAt('aaa');
const POST_B = idAt('bbb');
const POST_C = idAt('ccc');

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
// Seedless on purpose: the one thing this file asks the in-memory driver is whether a refusal
// lands before a row is read, and a fixture would only suggest the rows had something to do with it.
const memory = () => memoryRepo(likes, []);
const lastText = (): string => client.texts.at(-1) ?? '';
const lastValues = (): readonly unknown[] => client.statements.at(-1)?.values ?? [];

/** The predicate half of a statement — what `count()` and `countBy()` have to agree on exactly. */
const predicateOf = (text: string): string => {
  const grouped = text.indexOf(' group by ');
  return text.slice(text.indexOf(' where '), grouped === -1 ? undefined : grouped);
};

describe('the statement a grouped count compiles to', () => {
  test('it is the statement count() sends, one group by more, both outputs aliased', async () => {
    await repo().countBy('postId', { orgId: ORG });

    expect(lastText()).toBe(
      'select "post_id" as group_value, count(*) as group_count from "count_test_likes"' +
        ' where "org_id" = $1 and "deleted_at" is null group by "post_id" limit $2',
    );
    expect(lastValues()).toEqual([ORG, MAX_GROUPS + 1]);
  });

  test('the predicate is byte-for-byte the one count() would have sent', async () => {
    const args = { orgId: ORG, where: [{ column: 'reaction', op: 'eq' as const, value: 'like' }] };

    await repo().count(args);
    const counted = predicateOf(lastText());
    await repo().countBy('postId', args);

    // Compiled by one function over one plan, so a filter, a scope or a visibility rule that
    // changes for `count()` and not for `countBy()` is two different answers to one question.
    expect(predicateOf(lastText())).toBe(counted);
    expect(counted).toBe(' where "reaction" = $1 and "org_id" = $2 and "deleted_at" is null');
  });

  test('every value is bound, and so is the group bound — nothing is spliced in', async () => {
    const evil = "x'; drop table count_test_likes; --";

    await repo().countBy('postId', {
      orgId: ORG,
      where: [{ column: 'reaction', op: 'eq', value: evil }],
    });

    expect(lastText()).not.toContain('drop table');
    expect(lastText()).toContain('"reaction" = $1');
    // The bound is a parameter too — the one value in this statement no caller supplied, and so
    // the one a builder is tempted to concatenate.
    expect(lastText()).toEndWith('limit $3');
    expect(lastText()).not.toContain(String(MAX_GROUPS + 1));
    expect(lastValues()).toEqual([evil, ORG, MAX_GROUPS + 1]);
  });

  test('both outputs are aliased, so a column named count cannot collide with the aggregate', async () => {
    client.on('group by "count"', { rows: [{ group_value: 3, group_count: '4' }] });

    const counts = await repo().countBy('count', { orgId: ORG });

    expect(lastText()).toStartWith(
      'select "count" as group_value, count(*) as group_count from "count_test_likes"',
    );
    expect(lastText()).toContain('group by "count" limit $2');
    // Un-aliased, both outputs would be named `count` and one would have eaten the other.
    expect([...counts]).toEqual([[3, 4]]);
  });

  test('soft-deleted rows are out by default and in under includeDeleted', async () => {
    await repo().countBy('postId', { orgId: ORG });
    expect(lastText()).toContain('"deleted_at" is null');

    await repo().countBy('postId', { orgId: ORG, includeDeleted: true });
    expect(lastText()).not.toContain('"deleted_at" is null');
    expect(lastText()).toContain('group by "post_id"');
  });

  test('an unscoped grouped count refuses before a statement exists, in both drivers', async () => {
    await expect(repo().countBy('postId')).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(memory().countBy('postId')).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    // The guard every other read answers to, applied where it still costs nothing: an aggregate
    // that ran and was then filtered would already have read another tenant's rows.
    expect(client.statements).toHaveLength(0);

    await repo().countBy('postId', { orgId: ORG });
    expect(lastText()).toContain('"org_id" = $1');
    expect(lastValues()[0]).toBe(ORG);
  });
});

describe('what comes back off the wire', () => {
  test('count(*) arrives as an int8 string and lands in the map as a number', async () => {
    client.on('group by', { rows: [{ group_value: POST_A, group_count: '3' }] });

    const counts = await repo().countBy('postId', { orgId: ORG });

    expect(counts.get(POST_A)).toBe(3);
    // The type, not only the value: left as a string, `(counts.get(id) ?? 0) + 1` is '31'.
    expect([...counts.values()].map((value) => typeof value)).toEqual(['number']);
  });

  test('the group key is re-parsed by the column that declared it', async () => {
    client.on('group by "weight"', { rows: [{ group_value: '900', group_count: '2' }] });
    const byWeight = await repo().countBy('weight', { orgId: ORG });

    // int8 on the key side: '900' is a key the caller who wrote `900n` can never look up, and a
    // map that only answers `undefined` reads exactly like a table with no such row.
    expect([...byWeight.keys()]).toEqual([900n]);
    expect(byWeight.get('900')).toBeUndefined();

    client.on('group by "post_id"', { rows: [{ group_value: POST_A, group_count: '2' }] });
    expect([...(await repo().countBy('postId', { orgId: ORG })).keys()]).toEqual([POST_A]);
  });

  test('a null group_value is the one group SQL puts every NULL row in', async () => {
    client.on('group by', {
      rows: [
        { group_value: null, group_count: '2' },
        { group_value: POST_A, group_count: '1' },
      ],
    });

    const counts = await repo().countBy('postId', { orgId: ORG });

    expect(counts.get(null)).toBe(2);
    expect(counts.size).toBe(2);
  });
});

describe('the order the map comes back in', () => {
  test('biggest group first; ties by the value, numbers and bigints numerically', async () => {
    client.on('group by "count"', {
      rows: [
        { group_value: 20, group_count: '5' },
        { group_value: null, group_count: '5' },
        { group_value: 100, group_count: '5' },
        { group_value: 3, group_count: '9' },
        { group_value: 7, group_count: '1' },
      ],
    });

    const counts = await repo().countBy('count', { orgId: ORG });

    // 20 before 100: compared as text they would come back the other way round. And `null` is
    // last of the three that tie, not last of the five — the count still decides the position.
    expect([...counts.keys()]).toEqual([3, 20, 100, null, 7]);
    expect([...counts.values()]).toEqual([9, 5, 5, 5, 1]);

    client.on('group by "post_id"', {
      rows: [
        { group_value: POST_C, group_count: '2' },
        { group_value: null, group_count: '4' },
        { group_value: POST_A, group_count: '2' },
        { group_value: POST_B, group_count: '7' },
      ],
    });
    // Text ties by text; `null` sits where its own count of 4 puts it, in the middle.
    const byPost = await repo().countBy('postId', { orgId: ORG });
    expect([...byPost.keys()]).toEqual([POST_B, null, POST_A, POST_C]);

    client.on('group by "weight"', {
      rows: [
        { group_value: '100', group_count: '2' },
        { group_value: '20', group_count: '2' },
      ],
    });
    // Bigints numerically too — as text, '100' would sort before '20'.
    expect([...(await repo().countBy('weight', { orgId: ORG })).keys()]).toEqual([20n, 100n]);
  });
});
