// What a column refuses, and how: the refusal never carries the rejected value, and `timestamp()`
// takes only a string that names its instant. Split from `columns.test.ts` at its ceiling.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  boolean,
  enumerated,
  integer,
  locale,
  money,
  newId,
  text,
  timestamp,
  tz,
  url,
  uuid,
} from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
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

// A zoneless date-time was parsed at the HOST's zone on insert and seed, so one row was a different
// instant per container `TZ`. BREAKING (22.0.0): refused, as `t.date` refuses it at the wire.
describe('timestamp() takes only a string that names its instant', () => {
  test.each(['2026-03-14T09:00', '2026-03-14 09:00:00', 'March 14, 2026', '3/14/2026'])(
    '%p is refused',
    (value) => {
      expect(() => timestamp().$parse(value)).toThrow(/X_INVARIANT_VIOLATED/);
    },
  );

  test.each([
    ['2026-03-14T09:00:00Z', '2026-03-14T09:00:00.000Z'],
    ['2026-03-14T09:00:00+01:00', '2026-03-14T08:00:00.000Z'],
    ['2026-03-14', '2026-03-14T00:00:00.000Z'],
  ])('%p is %p', (value, iso) => {
    expect(timestamp().$parse(value).toISOString()).toBe(iso);
  });

  test('a Date and epoch milliseconds still pass', () => {
    const at = new Date('2026-03-14T09:00:00.000Z');
    expect(timestamp().$parse(at)).toBe(at);
    expect(timestamp().$parse(at.getTime()).getTime()).toBe(at.getTime());
  });
});
