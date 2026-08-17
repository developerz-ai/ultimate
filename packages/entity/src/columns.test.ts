import { afterAll, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import {
  boolean,
  enumerated,
  integer,
  locale,
  money,
  narrowMoney,
  newId,
  text,
  timestamp,
  tz,
  url,
  uuid,
} from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { MoneyValue } from './types';

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
    expect(() => price.$parse({ minor: 12.34, currency: 'EUR' })).toThrow(/1234, not 12\.34/);
  });

  test('accepts bigint, integer number and integer string — all land on one `number`', () => {
    // The column is `bigint` and a writer may hand one, but the VALUE is `@ultimat3/schema`'s
    // `MoneyValue`, whose `minor` is a number: the same amount read three ways is one row value.
    expect(price.$parse({ minor: 1234n, currency: 'EUR' }).minor).toBe(1234);
    expect(price.$parse({ minor: 1234, currency: 'EUR' }).minor).toBe(1234);
    expect(price.$parse({ minor: '-1234', currency: 'EUR' }).minor).toBe(-1234);
    for (const minor of [1234n, 1234, '1234']) {
      expect(typeof price.$parse({ minor, currency: 'EUR' }).minor).toBe('number');
    }
  });

  test('a minor unit past ±2^53 is refused, never rounded into the row', () => {
    // The `bigint` column holds more than a JS number does, so this is the one narrowing in the
    // package that can lose information — and the only honest answer is a coded refusal. Rounding
    // it would write a wrong amount; carrying it as a bigint is what broke `JSON.stringify`.
    const beyond = 9_007_199_254_740_993n;
    expect(() => price.$parse({ minor: beyond, currency: 'EUR' })).toThrow(/past ±2\^53/);
    expect(() => price.$parse({ minor: String(beyond), currency: 'EUR' })).toThrow(/past ±2\^53/);
    expect(() => price.$parse({ minor: -beyond, currency: 'EUR' })).toThrow(/past ±2\^53/);
    // The largest amount that IS exact still reads back exactly.
    expect(price.$parse({ minor: 9_007_199_254_740_991n, currency: 'EUR' }).minor).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  test('a row value is a `Money`: it survives JSON and its own schema node', () => {
    // The defect this representation closed. A bigint `minor` made `JSON.stringify` throw, so an
    // action returning a row with a money column crashed the response, and `t.money` — the node
    // that becomes the OpenAPI contract — rejected the row this framework's own driver produced.
    const value = price.$parse({ minor: '129900', currency: 'EUR' });
    expect(JSON.parse(JSON.stringify({ price: value }))).toEqual({
      price: { minor: 129_900, currency: 'EUR' },
    });
    expect(t.money.safeParse(value)).toEqual({ value: { minor: 129_900, currency: 'EUR' } });
    const asMoney: MoneyValue = value;
    expect(asMoney.currency).toBe('EUR');
  });

  test('narrowMoney is the write-side half, and it leaves an already-narrow row alone', () => {
    // Both drivers call it — `bindValues` before a statement, `memoryRepo` before it stores — so
    // a row's money never depends on which one produced it. Identity on the common path is the
    // point: a write with nothing to narrow must not allocate a second row to say so.
    const columns = { id: text(), price: money(), other: integer() };
    const narrow = { id: 'a', price: { minor: 1234, currency: 'EUR' }, other: 7 };
    expect(narrowMoney(columns, narrow)).toBe(narrow);

    const wide = { id: 'a', price: { minor: 1234n, currency: 'EUR' }, other: 7 };
    expect(narrowMoney(columns, wide)).toEqual(narrow);
    // The caller's object is theirs; narrowing copies rather than mutating it.
    expect(wide.price.minor).toBe(1234n);

    // A patch that names no money column, and a nullable money column left null, both pass through.
    const patch = { other: 9 };
    expect(narrowMoney(columns, patch)).toBe(patch);
    const absent = { id: 'a', price: null };
    expect(narrowMoney(columns, absent)).toBe(absent);

    // And the refusals are the read path's, not a second set: one message per mistake.
    expect(() => narrowMoney(columns, { price: { minor: 12.34, currency: 'EUR' } })).toThrow(
      /1234, not 12\.34/,
    );
    expect(() =>
      narrowMoney(columns, { price: { minor: 9_007_199_254_740_993n, currency: 'EUR' } }),
    ).toThrow(/past ±2\^53/);
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
      'monthly_scale',
    ]);
    expect(columns[1]?.kind).toBe('bigint');
    expect(columns[2]?.kind).toBe('char');
    // The scale column, and nullable: absent means the currency's own minor unit, which is what
    // every amount written before the column existed carries.
    expect(columns[3]?.kind).toBe('integer');
    expect(columns[3]?.notNull).toBe(false);
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

  test('a branded uuid is the same column at runtime — the brand is types only', () => {
    // `uuid<PostId>()` must not become a second kind of column: same meta, same validation, same
    // generated key. The brand's own claim is compile-time and lives in `type-pins.ts`.
    const plain = uuid().primaryKey();
    const branded = uuid<`${string}-post`>().primaryKey();
    expect(branded.$meta).toEqual(plain.$meta);
    expect(branded.$optional).toBe(plain.$optional);
    expect(() => branded.$parse('not-a-uuid')).toThrow(/expected a uuid/);
    expect(branded.$parse('018f1b3c-1c2a-7c3d-8e4f-5a6b7c8d9e0f')).toBe(
      '018f1b3c-1c2a-7c3d-8e4f-5a6b7c8d9e0f',
    );
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
    expect(described.indexes.map((index) => index.name)).toContain('columns_test_posts_org_id_idx');
  });

  test('text({ max }) reaches the database as a CHECK', () => {
    const notes = entity('columns_test_notes', {
      columns: { id: uuid().primaryKey(), title: text({ max: 80 }).unique() },
    });
    const title = notes.$describe().columns.find((column) => column.property === 'title');
    expect(title?.check).toBe('char_length(title) <= 80');
    expect(notes.$describe().indexes.map((index) => index.name)).toContain(
      'columns_test_notes_title_key',
    );
  });
});

/**
 * A column rejection is a PUBLIC surface: it becomes `X_INVARIANT_VIOLATED`'s `cause` and a
 * `$view` issue, which `@ultimat3/http` returns to the caller and writes into the log line — and
 * core's logger redacts by key, so a value already baked into a message has no key left to redact.
 * Every builder here used to render the rejected value with `String(value)`.
 */
describe('a rejected value never appears in the refusal', () => {
  const SECRET = 'sk-live-51H8xQ2eZvKYlo2C';
  const PASSWORD = 'hunter2';

  /** The message a builder produces for a value it refuses. */
  const refusalFor = (parse: (value: unknown) => unknown, value: unknown): string => {
    try {
      parse(value);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('the column accepted a value the test needs it to refuse');
  };

  const REFUSALS: readonly (readonly [string, (value: unknown) => unknown])[] = [
    ['uuid', uuid().$parse],
    ['integer', integer().$parse],
    ['timestamp', timestamp().$parse],
    ['enumerated', enumerated(['draft', 'published']).$parse],
    ['url', url().$parse],
    ['tz', tz(['Europe/Madrid']).$parse],
    ['locale', locale(['en', 'fr']).$parse],
    ['money', money().$parse],
  ];

  test.each(REFUSALS)('%s reports the shape and not one character of the value', (_name, parse) => {
    for (const value of [SECRET, PASSWORD]) {
      const message = refusalFor(parse, value);
      expect(message).not.toContain(value);
      // A four-character prefix is not a redaction: `sk-l` already names the vendor, and `hunt`
      // is most of a short password — a renderer that truncated instead of describing would pass
      // the assertion above and still be the same breach.
      expect(message).not.toContain(value.slice(0, 4));
      // What replaced it is the length and the type, which is what a type violation needs.
      expect(message).toContain(`a string of ${value.length} characters`);
    }
  });

  test('a string column reports a length, so the rule that rejected it is still readable', () => {
    // `text()` was already `typeof value`, which leaked nothing — but it also said nothing a
    // caller could act on. One renderer for every builder, so a column cannot be the exception.
    expect(refusalFor(text().$parse, 12345)).toEndWith(
      'column.type: expected a string, got a number',
    );
    expect(refusalFor(boolean().$parse, PASSWORD)).toContain('a string of 7 characters');
    expect(refusalFor(uuid().$parse, undefined)).toContain('got undefined');
    expect(refusalFor(uuid().$parse, null)).toContain('got null');
    expect(refusalFor(money().$parse, { minor: SECRET, currency: 'EUR' })).not.toContain('sk-l');
  });

  test('the value does not reach a $view issue either — the same message, one layer up', () => {
    const accounts = entity('columns_test_accounts', {
      columns: { id: uuid().primaryKey(), token: uuid() },
    });
    const view = accounts.$view(['id', 'token']);
    const rendered = JSON.stringify(view['~standard'].validate({ id: newId(), token: SECRET }));
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain('sk-l');

    // And the two `expected an object` refusals one level out, where the whole row is the value:
    // a POST body arriving as a JSON string is the widest thing this framework ever rejects.
    expect(refusalFor(accounts.$parse, SECRET)).toBe(
      'X_INVARIANT_VIOLATED: a domain invariant rejected this row — ' +
        'columns_test_accounts.row: expected an object, got a string of 24 characters',
    );
    expect(JSON.stringify(view['~standard'].validate(SECRET))).not.toContain('sk-l');
  });
});
