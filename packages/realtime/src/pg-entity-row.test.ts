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

  test('minor is a number whatever the column type decoded to — one shape per column', () => {
    // `pgoutput` hands an int8 back as a number and a numeric as text; both are the same money.
    const small = entityRow({ price_minor: 1990, price_currency: 'USD' });
    const text = entityRow({ price_minor: '1990', price_currency: 'USD' });
    expect(small).toEqual({ price: { minor: 1990, currency: 'USD' } });
    expect(text).toEqual({ price: { minor: 1990, currency: 'USD' } });
    const asMoney = small['price'] as { minor: unknown };
    const asMoneyFromText = text['price'] as { minor: unknown };
    expect(typeof asMoney.minor).toBe('number');
    expect(typeof asMoneyFromText.minor).toBe(typeof asMoney.minor);
  });

  test('a minor no JS number holds exactly is X_REPLICATION_PROTOCOL, not a silent string', () => {
    const physical: Record<string, JsonValue> = {
      price_minor: '9223372036854775807',
      price_currency: 'USD',
    };
    expect(() => entityRow(physical)).toThrow(/X_REPLICATION_PROTOCOL/);
    expect(() => entityRow(physical)).toThrow(/price_minor/);
  });

  test('a fractional minor is refused — money is never a float', () => {
    expect(() => entityRow({ price_minor: '19.90', price_currency: 'USD' })).toThrow(
      /X_REPLICATION_PROTOCOL/,
    );
    expect(() => entityRow({ price_minor: 19.9, price_currency: 'USD' })).toThrow(
      /X_REPLICATION_PROTOCOL/,
    );
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

  test('edge-shaped column names produce exactly these keys', () => {
    const physical: Record<string, JsonValue> = { _x: 1, x_: 2, a__b: 3 };
    expect(Object.keys(entityRow(physical))).toEqual(['X', 'x', 'aB']);
  });

  test('two columns that camelCase to one property are a named error, not a silent overwrite', () => {
    // `camel()` is not injective, and assignment would have kept only the second value.
    expect(() => entityRow({ a_b: 1, a__b: 2 })).toThrow(/X_REPLICATION_PROTOCOL/);
    expect(() => entityRow({ a_b: 1, a__b: 2 })).toThrow(/"a_b" and "a__b".*"aB"/);
    expect(() => entityRow({ x: 1, x_: 2 })).toThrow(/X_REPLICATION_PROTOCOL/);
  });

  test('a folded money property colliding with a plain column is named too', () => {
    expect(() => entityRow({ price: 1, price_minor: 500, price_currency: 'USD' })).toThrow(
      /both map to the entity property "price"/,
    );
  });
});
