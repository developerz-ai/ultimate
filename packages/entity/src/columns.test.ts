import { afterAll, describe, expect, test } from 'bun:test';
import {
  boolean,
  enumerated,
  integer,
  locale,
  money,
  text,
  timestamp,
  tz,
  url,
  uuid,
} from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  // The registry is process-global; a leaked entity breaks an unrelated package's tests.
  clearRegistry();
});

describe('money', () => {
  const price = money();

  test('rejects a float — 12.34 is not 1234 minor units', () => {
    expect(() => price.$parse({ minor: 12.34, currency: 'EUR' })).toThrow(
      /money-minor-units|float/,
    );
    expect(() => price.$parse({ minor: 0.1, currency: 'EUR' })).toThrow(/float/);
    expect(() => price.$parse({ minor: Number.NaN, currency: 'EUR' })).toThrow();
  });

  test('the message tells an agent exactly what to send instead', () => {
    expect(() => price.$parse({ minor: 12.34, currency: 'EUR' })).toThrow(/1234n/);
  });

  test('accepts bigint, integer number and integer string', () => {
    expect(price.$parse({ minor: 1234n, currency: 'EUR' }).minor).toBe(1234n);
    expect(price.$parse({ minor: 1234, currency: 'EUR' }).minor).toBe(1234n);
    expect(price.$parse({ minor: '-1234', currency: 'EUR' }).minor).toBe(-1234n);
  });

  test('is minor units plus an ISO-4217 code — never one column, never a float', () => {
    expect(() => price.$parse({ minor: 1n, currency: 'eur' })).toThrow(/iso-4217/);
    expect(() => price.$parse({ minor: 1n, currency: 'EURO' })).toThrow(/iso-4217/);

    const plans = entity('columns_test_plans', {
      columns: { code: text().primaryKey(), monthly: money() },
    });
    const columns = plans.$describe().columns;
    expect(columns.map((column) => column.column)).toEqual([
      'code',
      'monthly_minor',
      'monthly_currency',
    ]);
    expect(columns[1]?.kind).toBe('bigint');
    expect(columns[2]?.kind).toBe('char');
  });

  test('emits a database CHECK so psql cannot write a bad currency either', () => {
    const plans = entity('columns_test_catalog', {
      columns: { id: uuid().primaryKey(), price: money() },
    });
    const currency = plans.$describe().columns.find((column) => column.column === 'price_currency');
    expect(currency?.check).toBe("price_currency ~ '^[A-Z]{3}$'");
  });
});

describe('time', () => {
  test('a timestamp is always timestamptz — UTC storage is not optional', () => {
    expect(timestamp().$meta.kind).toBe('timestamptz');
    expect(timestamp().defaultNow().$meta.default).toEqual({ kind: 'generated', by: 'now' });
    expect(timestamp().defaultNow().onUpdateNow().$meta.onUpdate).toEqual({
      kind: 'generated',
      by: 'now',
    });
  });

  test('tz() takes IANA zones and refuses an abbreviation at declaration time', () => {
    const zone = tz(['Europe/Berlin', 'UTC']);
    expect(zone.$parse('Europe/Berlin')).toBe('Europe/Berlin');
    expect(() => zone.$parse('America/New_York')).toThrow(/iana-tz/);
    expect(() => tz(['CET+2'])).toThrow(/iana-tz/);
    expect(() => tz(['Mars/Olympus'])).toThrow(/iana-tz/);
  });
});

describe('the chain', () => {
  test('.nullable() widens the parser as well as the column', () => {
    const cover = url().nullable();
    expect(cover.$meta.notNull).toBe(false);
    expect(cover.$parse(null)).toBeNull();
    expect(cover.$parse('https://x.example/a.png')).toBe('https://x.example/a.png');
    expect(() => url().$parse('not-a-url')).toThrow(/absolute http/);
  });

  test('.primaryKey() on a uuid generates a v7 id, so an insert may omit it', () => {
    const id = uuid().primaryKey();
    expect(id.$meta.primaryKey).toBe(true);
    expect(id.$optional).toBe(true);
    expect(id.$meta.default).toEqual({ kind: 'generated', by: 'uuid-v7' });
    // A key that cannot be generated stays required.
    expect(text().primaryKey().$optional).toBe(false);
  });

  test('.default() marks the column optional and keeps its type', () => {
    const status = enumerated(['draft', 'published']).default('draft');
    expect(status.$optional).toBe(true);
    expect(status.$meta.default).toEqual({ kind: 'value', value: 'draft' });
    expect(() => status.$parse('archived')).toThrow(/expected one of/);
    expect(boolean().default(true).$meta.default).toEqual({ kind: 'value', value: true });
  });

  test('.references() and .tenant() index the column and record the target', () => {
    const orgs = entity('columns_test_orgs', { columns: { id: uuid().primaryKey() } });
    const posts = entity('columns_test_posts', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid()
          .references(() => orgs.id, { onDelete: 'cascade' })
          .tenant(),
        views: integer().default(0),
        lang: locale(['en', 'es']).default('en'),
      },
    });
    const described = posts.$describe();
    const org = described.columns.find((column) => column.property === 'orgId');
    // Physical names are derived from the property key; a name is written once, or never.
    expect(org?.column).toBe('org_id');
    expect(org?.references).toBe('columns_test_orgs.id');
    expect(described.orgScoped).toBe(true);
    expect(described.indexes).toContain('columns_test_posts_org_id_idx');
  });

  test('text({ max }) reaches the database as a CHECK', () => {
    const notes = entity('columns_test_notes', {
      columns: { id: uuid().primaryKey(), title: text({ max: 80 }).unique() },
    });
    const title = notes.$describe().columns.find((column) => column.property === 'title');
    expect(title?.check).toBe('char_length(title) <= 80');
    expect(notes.$describe().indexes).toContain('columns_test_notes_title_key');
  });
});
