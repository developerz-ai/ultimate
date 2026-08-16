// The enforcement for `describe-value.ts`'s one rule: a rejected value's CONTENT never reaches an
// issue message. The failure case comes first and is the reason the file exists — `X_BODY_INVALID`
// used to carry `received "hunter2"` into the response body and the log line at once.

import { describe, expect, test } from 'bun:test';
import { describeValue, expected } from './describe-value';
import { ValidationFailedError } from './errors';
import { validate } from './standard';
import { builtinT, objectSchema } from './validators';

/** Values a real form actually carries. Every one of these used to be echoed verbatim. */
const SECRETS = [
  'hunter2',
  'sk-live-51H8xQ2eZvKYlo2C',
  '4111111111111111',
  '078-05-1120',
  'dev.admin@tesote.com',
  'Bearer eyJhbGciOiJIUzI1NiJ9.body.sig',
] as const;

describe('a rejected value never appears in the message it is rejected with', () => {
  test('describeValue leaks no secret verbatim, and no substring of one', () => {
    for (const secret of SECRETS) {
      const rendered = describeValue(secret);
      expect(rendered).not.toContain(secret);
      // A prefix is a leak too: `sk-live` is enough to know which vendor's key was pasted.
      expect(rendered).not.toContain(secret.slice(0, 4));
    }
  });

  test('expected() leaks nothing either — the value goes through describeValue, always', () => {
    expect(expected('a non-empty string of at least 12 chars', 'hunter2')).toBe(
      'expected a non-empty string of at least 12 chars, received a string of 7 characters',
    );
  });

  test('the whole password path: a min-length refusal names the rule, not the password', () => {
    // The proven breach: POST /login {"password":"hunter2"} against `minLength: 12`. The issue
    // message is what `@ultimat3/http` folds into X_BODY_INVALID's cause, which is both returned
    // to the caller and written to the log line, where no key is left to redact.
    const login = objectSchema({ password: builtinT.string.min(12) });
    const result = validate(login, { password: 'hunter2' });
    const message = result.issues?.[0]?.message ?? '';
    expect(message).toBe(
      'expected a non-empty string of at least 12 chars, received a string of 7 characters',
    );
    expect(message).not.toContain('hunter2');
  });

  test('nothing on a thrown ValidationFailedError carries the value — cause, meta or format()', () => {
    const login = objectSchema({ password: builtinT.string.min(12), apiKey: builtinT.uuid });
    let caught: unknown;
    try {
      login.parse({ password: 'hunter2', apiKey: 'sk-live-51H8xQ2eZvKYlo2C' }, 'body');
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(ValidationFailedError);
    const error = caught as ValidationFailedError;
    const surfaces = [
      error.cause,
      error.message,
      error.format(),
      error.formatIssues(),
      JSON.stringify(error.toJSON()),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain('hunter2');
      expect(surface).not.toContain('sk-live');
    }
    // `received` stays empty for the same reason the message does.
    expect(error.issues.map((issue) => issue.received)).toEqual(['', '']);
  });

  test('every builtin refuses a secret without quoting it', () => {
    const schemas = [
      builtinT.uuid,
      builtinT.email,
      builtinT.url,
      builtinT.slug,
      builtinT.cursor,
      builtinT.timezone,
      builtinT.locale,
      builtinT.number,
      builtinT.boolean,
      builtinT.date,
      builtinT.money,
      builtinT.string.max(3),
      builtinT.string.pattern(/^[a-z]+$/),
    ];
    for (const schema of schemas) {
      for (const secret of SECRETS) {
        const rendered = (validate(schema, secret).issues ?? [])
          .map((issue) => issue.message)
          .join(' | ');
        expect(rendered).not.toContain(secret);
      }
    }
  });

  test('a nested object, an array and a record all stay quiet too', () => {
    const schema = objectSchema({
      cards: builtinT.array(objectSchema({ pan: builtinT.uuid })),
      meta: builtinT.record(builtinT.number),
    });
    const rendered = (
      validate(schema, {
        cards: [{ pan: '4111111111111111' }],
        meta: { ssn: '078-05-1120' },
      }).issues ?? []
    )
      .map((issue) => issue.message)
      .join(' | ');
    expect(rendered).not.toContain('4111');
    expect(rendered).not.toContain('078-05');
  });
});

describe('describeValue reports the shape', () => {
  test('undefined and null name themselves', () => {
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(null)).toBe('null');
  });

  test('a string is a length', () => {
    expect(describeValue('')).toBe('an empty string');
    expect(describeValue('a')).toBe('a string of 1 character');
    expect(describeValue('hunter2')).toBe('a string of 7 characters');
  });

  test('a number is a number, except the four constants that are facts', () => {
    expect(describeValue(42)).toBe('a number');
    expect(describeValue(-0.5)).toBe('a number');
    expect(describeValue(Number.NaN)).toBe('NaN');
    expect(describeValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(describeValue(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  test('a boolean is a boolean — true and false render identically', () => {
    expect(describeValue(true)).toBe('a boolean');
    expect(describeValue(false)).toBe('a boolean');
  });

  test('an array is a count', () => {
    expect(describeValue([])).toBe('an empty array');
    expect(describeValue([1])).toBe('an array of 1 item');
    expect(describeValue([1, 2, 3])).toBe('an array of 3 items');
  });

  test('a Date says only whether it is valid — never the instant', () => {
    expect(describeValue(new Date('2026-01-01T00:00:00.000Z'))).toBe('a Date');
    expect(describeValue(new Date('not a date'))).toBe('an invalid Date');
  });

  test('an object is an object — no keys, no values', () => {
    expect(describeValue({})).toBe('an object');
    expect(describeValue({ ssn: '078-05-1120' })).toBe('an object');
  });

  test('the remaining typeofs render without calling toString on the value', () => {
    expect(describeValue(10n)).toBe('a bigint');
    expect(describeValue(Symbol('secret-name'))).toBe('a symbol');
    expect(describeValue(() => 'secret')).toBe('a function');
  });
});
