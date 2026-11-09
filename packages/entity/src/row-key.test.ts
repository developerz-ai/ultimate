// One row's identity as a string, for both drivers. The Postgres driver joined a composite key with
// `''`, so `('a', 'bc')` and `('ab', 'c')` were one id; memory joined with an invisible U+0001,
// which text holds as well — `('a\u0001', 'b')` and `('a', '\u0001b')` were one stored row.
import { afterAll, describe, expect, test } from 'bun:test';
import { integer, text, uuid } from './columns';
import { memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { rowKey } from './row-key';

afterAll(() => {
  clearRegistry();
});

const pairs = entity('row_key_pairs', {
  primaryKey: ['left', 'right'],
  columns: { left: text(), right: text(), seats: integer() },
});
const single = entity('row_key_single', { columns: { id: uuid().primaryKey() } });

describe('rowKey', () => {
  test('a composite key cannot collide by concatenation', () => {
    expect(rowKey(pairs, { left: 'a', right: 'bc' })).not.toBe(
      rowKey(pairs, { left: 'ab', right: 'c' }),
    );
  });

  test('a single key is the canonical value — a uuid in any case is one row', () => {
    const id = '0190a0b0-0000-7000-8000-00000000000A';
    expect(rowKey(single, { id })).toBe(rowKey(single, { id: id.toLowerCase() }));
    expect(rowKey(single, { id })).toBe(id.toLowerCase());
  });

  test('…nor by any separator a text value can hold', () => {
    expect(rowKey(pairs, { left: 'a\u0001', right: 'b' })).not.toBe(
      rowKey(pairs, { left: 'a', right: '\u0001b' }),
    );
  });

  test('the memory driver stores both composite rows', async () => {
    const repo = memoryDriver().repo(pairs);
    await repo.insert({ left: 'a\u0001', right: 'b', seats: 1 });
    await repo.insert({ left: 'a', right: '\u0001b', seats: 2 });
    expect((await repo.findMany({})).rows.map((row) => row.seats).sort()).toEqual([1, 2]);
  });
});
