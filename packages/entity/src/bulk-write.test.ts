// Single responsibility: what ONE many-row statement carries, decided in property space — the
// column list a batch writes and how many rows fit inside Postgres's bind count. Which batches an
// upsert refuses, and what a collision overwrites, is `upsert-plan.test.ts`'s subject; both read
// the same `bulk-write.ts`, so a rule missing from either is one the two drivers may disagree on.

import { afterAll, describe, expect, test } from 'bun:test';
import { insertChunks, insertColumns, MAX_BIND_PARAMETERS, namedProperties } from './bulk-write';
import { integer, money, text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { RowPatch } from './types';

const items = entity('bulk_items', {
  columns: {
    id: uuid().primaryKey(),
    sku: text().unique(),
    serial: text().nullable().unique(),
    label: text(),
    unitPrice: money(),
    quantity: integer(),
  },
});

type Item = typeof items.$row;

const ID = '0192f5a0-0000-7000-8000-00000000000a';

const item = { id: ID, sku: 'a', label: 'l', quantity: 1 };

afterAll(() => {
  clearRegistry();
});

describe('the columns a batch writes', () => {
  test('names them in declaration order, never in the order the caller happened to write', () => {
    // The statement's column list is shared by every row in the chunk, so it cannot depend on
    // which row was read first — one row spelling it backwards would bind the wrong values.
    expect(namedProperties(items, [{ quantity: 2, sku: 'a' }])).toEqual(['sku', 'quantity']);
    expect(Object.keys(items.$columns)).toEqual([
      'id',
      'sku',
      'serial',
      'label',
      'unitPrice',
      'quantity',
    ]);
  });

  test('unions the batch: a column one row names is a column the statement carries', () => {
    expect(namedProperties(items, [{ sku: 'a' }, { quantity: 1 }, { sku: 'b' }])).toEqual([
      'sku',
      'quantity',
    ]);
  });

  test('a property present and undefined is a value the caller wrote', () => {
    // `Object.hasOwn`, exactly as `bindValues` decides it — dropping the column here would insert
    // one the update set then skipped. It used to take a cast to say: `Partial<Item>` cannot spell
    // a present-`undefined` property under `exactOptionalPropertyTypes`, so the one value this
    // test exists for was the one value the parameter type refused. `RowPatch<Item>` spells it.
    const written: RowPatch<Item> = { label: undefined };
    expect(namedProperties(items, [written])).toEqual(['label']);
    expect(namedProperties(items, [{}])).toEqual([]);
    expect(namedProperties(items, [])).toEqual([]);
  });

  test('a key the entity never declared is not a column', () => {
    const stray = { sku: 'a', nickname: 'nope' } as Partial<Item>;
    expect(namedProperties(items, [stray])).toEqual(['sku']);
  });

  test('money is three physical columns, expanded in place and snake_cased', () => {
    expect(insertColumns(items, ['id', 'unitPrice', 'quantity'])).toEqual([
      'id',
      'unit_price_minor',
      'unit_price_currency',
      'unit_price_scale',
      'quantity',
    ]);
  });

  test('the physical width is what the chunker divides, not the property count', () => {
    const properties = namedProperties(items, [
      { ...item, serial: null, unitPrice: { minor: 1234, currency: 'EUR' } },
    ]);
    expect(properties).toHaveLength(6);
    expect(insertColumns(items, properties)).toHaveLength(8);
  });

  test('a property the entity does not declare contributes no column', () => {
    expect(insertColumns(items, ['nope'])).toEqual([]);
  });
});

describe('how many rows fit in one statement', () => {
  const numbers = (count: number): readonly number[] => Array.from({ length: count }, (_, i) => i);

  test('an empty batch is no statements at all', () => {
    expect(insertChunks([], 4)).toEqual([]);
  });

  test('a batch inside the bind budget is one statement', () => {
    expect(insertChunks([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  test('a batch past it is several, in order, none wider than the budget', () => {
    const width = 21845; // 65535 / 3, so three rows fit and a fourth does not
    const chunks = insertChunks(numbers(7), width);
    expect(chunks.map((chunk) => chunk.length)).toEqual([3, 3, 1]);
    expect(chunks.flat()).toEqual([...numbers(7)]);
    for (const chunk of chunks) {
      expect(chunk.length * width).toBeLessThanOrEqual(MAX_BIND_PARAMETERS);
    }
  });

  test('the split lands exactly on the bind count, not one row short of it', () => {
    // 13107 rows × 5 columns is 65535 binds — the widest statement Postgres accepts, and a
    // chunker that rounded down would pay a second round trip for every batch this size.
    const chunks = insertChunks(numbers(13108), 5);
    expect(chunks.map((chunk) => chunk.length)).toEqual([13107, 1]);
    expect(13107 * 5).toBe(MAX_BIND_PARAMETERS);
  });

  test('a row wider than the whole budget still goes, one row per statement', () => {
    expect(insertChunks(['a', 'b', 'c'], MAX_BIND_PARAMETERS + 1)).toEqual([['a'], ['b'], ['c']]);
  });

  test('a width nobody could divide by is one statement, never zero-sized chunks', () => {
    expect(insertChunks([1, 2], 0)).toEqual([[1, 2]]);
    expect(insertChunks([1, 2], -3)).toEqual([[1, 2]]);
  });
});
