// `decodeRow` reads a per-entity plan: the column names are derived once per column map, never
// per row. The plan must not change one answer — a narrowed row, both money shapes, a renamed
// column, a sealed column and a null in either kind of column decode as they always did.

import { afterAll, describe, expect, test } from 'bun:test';
import { boolean, integer, money, text, timestamp, uuid } from './columns';
import type { EntityCore } from './entity';
import { entity } from './entity';
import { decodeRow } from './pg-row';
import { clearRegistry } from './registry';

const ID = '0198c1a0-0000-7000-8000-000000000001';

const posts = entity('pg_row_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text(),
    viewCount: integer(),
    slug: text().column('url_slug'),
    price: money(),
    fee: money({ columns: { minor: 'fee_cents', currency: 'fee_ccy', scale: null } }),
    note: text().nullable(),
    secret: text().sealed(),
    publishedAt: timestamp(),
    isDraft: boolean(),
  },
});

const PHYSICAL = {
  id: ID,
  title: 'Hello',
  view_count: 3,
  url_slug: 'hello',
  price_minor: '1250',
  price_currency: 'EUR',
  price_scale: 4,
  fee_cents: 99,
  fee_ccy: 'USD ',
  note: null,
  secret: 'sealed-envelope',
  published_at: new Date('2026-11-06T10:00:00.000Z'),
  is_draft: false,
};

afterAll(() => {
  clearRegistry();
});

describe('unit · decodeRow', () => {
  test('derives the column names once per column map, not once per row', () => {
    let reads = 0;
    const counted = new Proxy(posts.$columns, {
      ownKeys(target) {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    });
    // Over the real entity, only `$columns` replaced: a spread would read the `$row` type getter.
    const core: EntityCore<unknown> = Object.create(posts, { $columns: { value: counted } });
    decodeRow(core, PHYSICAL);
    decodeRow(core, PHYSICAL);
    decodeRow(core, PHYSICAL);
    expect(reads).toBe(1);
  });

  test('the whole row decodes as it always did', () => {
    expect(decodeRow(posts, PHYSICAL)).toEqual({
      id: ID,
      title: 'Hello',
      viewCount: 3,
      slug: 'hello',
      price: { minor: 1250, currency: 'EUR', scale: 4 },
      fee: { minor: 99, currency: 'USD' },
      note: null,
      // Sealed: handed up unparsed, for the sealing seam to open.
      secret: 'sealed-envelope',
      publishedAt: new Date('2026-11-06T10:00:00.000Z'),
      isDraft: false,
    });
  });

  test('a narrowed row stays narrowed, and an absent scale is no scale', () => {
    const narrowed = { id: ID, url_slug: 'hello', price_minor: 5, price_currency: 'EUR' };
    // Widened: the decoded row is typed whole, and narrowing is exactly what this asserts it is not.
    const decoded: unknown = decodeRow(posts, narrowed);
    expect(decoded).toEqual({
      id: ID,
      slug: 'hello',
      price: { minor: 5, currency: 'EUR' },
    });
  });

  test('a null money amount in a not-null column is refused', () => {
    const { price_minor: _minor, ...rest } = PHYSICAL;
    expect(() => decodeRow(posts, { ...rest, price_minor: null })).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }),
    );
  });

  test('null in a not-null column is refused; in a nullable one it is null', () => {
    expect(() => decodeRow(posts, { ...PHYSICAL, title: null })).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }),
    );
    expect(decodeRow(posts, { ...PHYSICAL, note: null })).toMatchObject({ note: null });
    expect(decodeRow(posts, { ...PHYSICAL, note: 'kept' })).toMatchObject({ note: 'kept' });
  });

  test('two entities over one table shape keep their own plans', () => {
    const renamed = entity('pg_row_renamed', {
      columns: { id: uuid().primaryKey(), title: text().column('headline') },
    });
    expect(decodeRow(renamed, { id: ID, headline: 'A', title: 'wrong' })).toEqual({
      id: ID,
      title: 'A',
    });
    expect(decodeRow(posts, { ...PHYSICAL, headline: 'ignored' }).title).toBe('Hello');
  });
});
