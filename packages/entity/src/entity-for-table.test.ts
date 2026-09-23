// Single responsibility: resolving a PHYSICAL table to its entity, and decoding a raw row through
// it — what a change feed needs. `@ultimat3/realtime` guessed money columns from column NAMES
// because nothing public turned `posts` + `{ price_minor, price_currency }` into a row.

import { afterAll, describe, expect, test } from 'bun:test';
import { money, text, uuid } from './columns';
import { entity } from './entity';
import { decodeRow, entityForTable } from './index';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const products = entity('eft_product', {
  table: 'eft_products',
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }), price: money() },
});

describe('entityForTable', () => {
  test('answers the entity declared on that physical table', () => {
    expect(entityForTable('eft_products')?.$name).toBe('eft_product');
  });

  test('an unknown table is undefined, never a guess', () => {
    expect(entityForTable('nope')).toBeUndefined();
    expect(entityForTable('eft_product')).toBeUndefined();
  });
});

describe('decodeRow', () => {
  test('a raw row decodes money by the column kind, never by the name', () => {
    const core = entityForTable('eft_products');
    if (core === undefined) return expect.unreachable('declared above');
    const row = decodeRow(core, {
      id: '00000000-0000-7000-8000-000000000001',
      name: 'Mug',
      price_minor: 1200,
      price_currency: 'EUR',
    });
    expect(row).toMatchObject({ name: 'Mug', price: { minor: 1200, currency: 'EUR' } });
    expect(products.$name).toBe('eft_product');
  });
});
