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

  /**
   * The pairing with `@ultimat3/entity`'s `parseMinor` is "echo what is provably numeric", and a
   * WAL column matched by *name* proves nothing on its own: a `text` column called `note_minor`
   * beside `note_currency` puts user content in a message no field-level redaction can reach.
   */
  test('a numeric amount is named, and content that is not a number is described instead', () => {
    // Provably numeric: the amount is the fact that repairs the row, so it survives.
    expect(() => entityRow({ price_minor: '19.90', price_currency: 'USD' })).toThrow(/19\.90/);
    expect(() => entityRow({ price_minor: 19.9, price_currency: 'USD' })).toThrow(/19\.9/);

    // Not a number: shape only, and the content appears nowhere in the message.
    let thrown = '';
    try {
      entityRow({ note_minor: 'hunter2', note_currency: 'USD' });
    } catch (error) {
      thrown = String((error as { cause?: unknown }).cause ?? '');
    }
    expect(thrown).toContain('a string of 7 characters');
    expect(thrown).not.toContain('hunter2');
  });

  test('a scale column folds into the money property rather than beside it', () => {
    const physical: Record<string, JsonValue> = {
      id: '1',
      price_minor: 2,
      price_currency: 'USD',
      price_scale: 6,
    };
    expect(entityRow(physical)).toEqual({
      id: '1',
      price: { minor: 2, currency: 'USD', scale: 6 },
    });
  });

  test('a NULL scale is consumed and produces no scale key — NULL is not 0', () => {
    // `0` means whole units; NULL means the currency's own minor unit. A `scale: 0` here would
    // be a 100x reinterpretation of every ordinary price.
    const folded = entityRow({ price_minor: 1990, price_currency: 'USD', price_scale: null });
    expect(folded).toEqual({ price: { minor: 1990, currency: 'USD' } });
    expect(Object.hasOwn(folded['price'] as object, 'scale')).toBe(false);
  });

  test('an absent scale column produces no scale key either', () => {
    const folded = entityRow({ price_minor: 1990, price_currency: 'USD' });
    expect(Object.hasOwn(folded['price'] as object, 'scale')).toBe(false);
  });

  test('scale is a number whatever the column type decoded to', () => {
    expect(entityRow({ price_minor: 2, price_currency: 'USD', price_scale: '6' })).toEqual({
      price: { minor: 2, currency: 'USD', scale: 6 },
    });
  });

  test('a scale that is not a whole number of decimal places is X_REPLICATION_PROTOCOL', () => {
    expect(() => entityRow({ price_minor: 2, price_currency: 'USD', price_scale: 6.5 })).toThrow(
      /X_REPLICATION_PROTOCOL/,
    );
    expect(() => entityRow({ price_minor: 2, price_currency: 'USD', price_scale: 6.5 })).toThrow(
      /price_scale/,
    );
  });

  test('a scale that is not a number at all is described, never echoed', () => {
    let thrown = '';
    try {
      entityRow({ note_minor: 5, note_currency: 'USD', note_scale: 'hunter2' });
    } catch (error) {
      thrown = String((error as { cause?: unknown }).cause ?? '');
    }
    expect(thrown).toContain('a string of 7 characters');
    expect(thrown).not.toContain('hunter2');
  });

  test('a lone scale column with no money pair stays an ordinary column', () => {
    expect(entityRow({ price_scale: 6 })).toEqual({ priceScale: 6 });
    expect(entityRow({ price_minor: 500, price_scale: 6 })).toEqual({
      priceMinor: 500,
      priceScale: 6,
    });
  });

  test('scale arriving first still folds at its (earlier) position', () => {
    const physical: Record<string, JsonValue> = {
      id: '1',
      price_scale: 6,
      price_minor: 2,
      price_currency: 'USD',
      name: 'widget',
    };
    expect(Object.keys(entityRow(physical))).toEqual(['id', 'price', 'name']);
    expect(entityRow(physical)).toEqual({
      id: '1',
      price: { minor: 2, currency: 'USD', scale: 6 },
      name: 'widget',
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
