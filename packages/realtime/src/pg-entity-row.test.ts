import { describe, expect, test } from 'bun:test';
import type { JsonValue } from './json';
import { camel, entityRow } from './pg-entity-row';

describe('camel', () => {
  test('inverts @ultimat3/entity/src/column.ts#snake() for realistic property names', () => {
    // `snake()` there is `value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()` — that
    // package is tier 2 and this one is tier 3, so it cannot be imported here; these pairs are
    // its hand-verified output for common entity property names, and camel() must invert them.
    const pairs: Record<string, string> = {
      id: 'id',
      orgId: 'org_id',
      publishedAt: 'published_at',
      authorId: 'author_id',
      deletedAt: 'deleted_at',
      viewCount: 'view_count',
    };
    for (const [property, column] of Object.entries(pairs)) {
      expect(camel(column)).toBe(property);
    }
  });

  test('leading, trailing, and doubled underscores do not throw or produce "undefined"', () => {
    for (const column of ['_x', 'x_', 'a__b', '_', '']) {
      expect(() => camel(column)).not.toThrow();
      expect(camel(column)).not.toContain('undefined');
    }
  });
});

describe('entityRow', () => {
  test('folds a minor/currency column pair into one money property', () => {
    const physical: Record<string, JsonValue> = {
      id: '1',
      price_minor: 500,
      price_currency: 'USD',
    };
    expect(entityRow(physical)).toEqual({
      id: '1',
      price: { minor: 500, currency: 'USD' },
    });
  });

  test('keeps an out-of-safe-range minor as a string inside the money object', () => {
    const physical: Record<string, JsonValue> = {
      price_minor: '9223372036854775807',
      price_currency: 'USD',
    };
    expect(entityRow(physical)).toEqual({
      price: { minor: '9223372036854775807', currency: 'USD' },
    });
  });

  test('a lone minor column with no currency partner stays an ordinary column', () => {
    const physical: Record<string, JsonValue> = { price_minor: 500 };
    expect(entityRow(physical)).toEqual({ priceMinor: 500 });
  });

  test('a lone currency column with no minor partner stays an ordinary column', () => {
    const physical: Record<string, JsonValue> = { price_currency: 'USD' };
    expect(entityRow(physical)).toEqual({ priceCurrency: 'USD' });
  });

  test('a null currency does not fold — half a pair is not money', () => {
    const physical: Record<string, JsonValue> = { price_minor: 500, price_currency: null };
    expect(entityRow(physical)).toEqual({ priceMinor: 500, priceCurrency: null });
  });

  test('key order follows column order; money is folded at its first-seen position', () => {
    const physical: Record<string, JsonValue> = {
      id: '1',
      price_minor: 500,
      price_currency: 'USD',
      name: 'widget',
    };
    expect(Object.keys(entityRow(physical))).toEqual(['id', 'price', 'name']);
  });

  test('currency arriving before minor still folds at its (earlier) position', () => {
    const physical: Record<string, JsonValue> = {
      id: '1',
      price_currency: 'USD',
      price_minor: 500,
    };
    expect(Object.keys(entityRow(physical))).toEqual(['id', 'price']);
    expect(entityRow(physical)).toEqual({ id: '1', price: { minor: 500, currency: 'USD' } });
  });

  test('edge-shaped column names do not produce "undefined" keys or throw', () => {
    const physical: Record<string, JsonValue> = { _x: 1, x_: 2, a__b: 3 };
    expect(() => entityRow(physical)).not.toThrow();
    const row = entityRow(physical);
    expect(Object.keys(row).some((key) => key.includes('undefined'))).toBe(false);
  });
});
