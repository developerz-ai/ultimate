// What holds an `updateMany`'s statements together, against a recording client: no `BEGIN` for one
// statement and no rule to judge, one transaction for several or for a rule only the app can judge,
// the rows decoded and judged inside it, and a count otherwise.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type RecordingClient, recordingClient, setDbClient, sql } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { invariant, MAX_ASSERTED_ROWS } from './invariants';
import { clearRegistry } from './registry';
import { updateManyPlan } from './update-many';
import { sendUpdateMany, updateManyReturns } from './update-many-send';

const plain = entity('um_send_plain', {
  columns: { id: uuid().primaryKey(), note: text() },
});

const ruled = entity('um_send_ruled', {
  columns: { id: uuid().primaryKey(), rank: integer() },
  invariants: (c) => [
    invariant(
      'rank_small',
      c.satisfies((rank) => rank < 100, ['rank']),
    ),
  ],
});

const ID = '00000000-0000-7000-8000-000000000001';
const UPDATE = sql`update "um_send" set "note" = $1`;

let client: RecordingClient;

beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const verbs = (): readonly string[] => client.texts.map((text) => text.split(' ')[0] ?? '');

describe('sendUpdateMany', () => {
  test('one statement, nothing to judge: autocommit, answered with a count', async () => {
    client.on('update', { affected: 3 });
    const result = await sendUpdateMany(plain, [UPDATE], false, client, undefined);
    expect(result).toEqual({ count: 3, rows: [] });
    expect(verbs()).toEqual(['update']);
  });

  test('several statements are one transaction, their counts summed', async () => {
    client.on('update', { affected: 2 });
    const result = await sendUpdateMany(plain, [UPDATE, UPDATE], false, client, undefined);
    expect(result.count).toBe(4);
    expect(client.texts.filter((text) => text.startsWith('update'))).toHaveLength(2);
    expect(verbs().at(0)).not.toBe('update');
  });

  test('returning decodes the stored rows and counts them', async () => {
    client.on('update', { rows: [{ id: ID, note: 'n' }] });
    const result = await sendUpdateMany(plain, [UPDATE], true, client, undefined);
    expect(result).toEqual({ count: 1, rows: [{ id: ID, note: 'n' }] });
  });

  test('an app-only rule judges the stored rows inside a transaction, refusing the write', async () => {
    client.on('update', { rows: [{ id: ID, rank: 500 }] });
    let code = 'resolved';
    try {
      await sendUpdateMany(ruled, [UPDATE], true, client, undefined);
    } catch (error) {
      code = isUltimateError(error) ? error.code : String(error);
    }
    expect(code).toBe('X_INVARIANT_VIOLATED');
    // The statement went out inside a transaction, so the refusal took it back.
    expect(verbs().at(0)).not.toBe('update');
    expect(client.texts.at(-1)?.toLowerCase()).toContain('rollback');
  });
});

describe('updateManyReturns', () => {
  const planOf = (rows: number) =>
    updateManyPlan(
      plain,
      Array.from({ length: rows }, (_, index) => ({
        id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        patch: { note: 'n' },
      })),
      undefined,
    );

  test('nobody asked for the rows: a count', () => {
    expect(updateManyReturns(plain, planOf(2), false)).toBe(false);
  });

  test('the search mirror asked, and the batch fits the bound: the rows', () => {
    expect(updateManyReturns(plain, planOf(2), true)).toBe(true);
  });

  test('the search mirror asked, past the bound: still a count', () => {
    expect(updateManyReturns(plain, planOf(MAX_ASSERTED_ROWS + 1), true)).toBe(false);
  });

  test('an app-only rule always reads the rows back', () => {
    const plan = updateManyPlan(ruled, [{ id: ID, patch: { rank: 1 } }], undefined);
    expect(updateManyReturns(ruled, plan, false)).toBe(true);
  });
});
