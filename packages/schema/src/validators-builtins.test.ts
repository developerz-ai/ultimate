// Single responsibility: pins the BUILTIN SCALAR validators' accept/reject contract at the public
// `validate()` boundary. Split from `validators.test.ts`, which keeps the combinators
// (object/array/union/record/refine/nullable/optional) — the two halves answer different
// questions and together were over the 500-line ceiling.

import { describe, expect, test } from 'bun:test';
import { validate } from './standard';
import { builtinT } from './validators';

const UUID = '018f4a1c-1b2c-7d3e-8f90-abcdef012345';

describe('builtinT.string', () => {
  test('rejects an empty string by default', () => {
    expect(validate(builtinT.string, '').issues).toBeDefined();
  });

  test('rejects non-strings', () => {
    expect(validate(builtinT.string, 123).issues).toBeDefined();
  });

  test('a pattern keeps its flags, in the check and in the message', () => {
    // The node held `regex.source` alone, so `new RegExp(node.pattern)` was a DIFFERENT regex:
    // `/^[a-z]+$/i` refused `ABC` and the error quoted the pattern that would have matched it.
    const insensitive = builtinT.string.pattern(/^[a-z]+$/i);
    expect(insensitive.node.patternFlags).toBe('i');
    expect(validate(insensitive, 'ABC').issues).toBeUndefined();
    expect(validate(insensitive, 'abc').issues).toBeUndefined();
    expect(validate(insensitive, 'A1').issues).toBeDefined();
    expect(validate(insensitive, 'A1').issues?.[0]?.message).toContain('/^[a-z]+$/i');
    // An unflagged pattern carries no flags field and its message is unchanged.
    const plain = builtinT.string.pattern(/^[a-z]+$/);
    expect(plain.node.patternFlags).toBeUndefined();
    expect(validate(plain, 'ABC').issues).toBeDefined();
  });

  test('min/max/pattern chain onto a new schema without mutating the original', () => {
    const withMin = builtinT.string.min(3);
    expect(withMin.node.minLength).toBe(3);
    expect(builtinT.string.node.minLength).toBe(1);

    const withMax = builtinT.string.max(5);
    expect(withMax.node.maxLength).toBe(5);
    expect(builtinT.string.node.maxLength).toBeUndefined();

    const withPattern = builtinT.string.pattern(/^[a-z]+$/);
    expect(withPattern.node.pattern).toBe('^[a-z]+$');
    expect(builtinT.string.node.pattern).toBeUndefined();
  });

  test('min/max count characters, the unit the emitted JSON Schema promises', () => {
    // JSON Schema defines `minLength`/`maxLength` over CODE POINTS, and the message already said
    // "chars" — but the check counted UTF-16 code units, so `t.string.max(1)` refused a value a
    // human, the published schema and Postgres' `char_length` all read as one character.
    expect(validate(builtinT.string.max(1), '👍').issues).toBeUndefined();
    expect(validate(builtinT.string.max(1), '👍👍').issues).toBeDefined();
    expect(validate(builtinT.string.min(2), '👍👍').issues).toBeUndefined();
    expect(validate(builtinT.string.min(2), '👍').issues).toBeDefined();
  });

  test('a global pattern gives the same verdict every time it is asked', () => {
    // The RegExp is compiled once per schema now; a `g` flag carries `lastIndex` between calls,
    // so the second `.test()` of an identical value would answer `false`.
    const global = builtinT.string.pattern(/[a-z]+/g);
    expect(validate(global, 'abc').issues).toBeUndefined();
    expect(validate(global, 'abc').issues).toBeUndefined();
    expect(validate(global, 'abc').issues).toBeUndefined();
  });

  test('enforces min/max/pattern once chained', () => {
    const schema = builtinT.string
      .min(3)
      .max(5)
      .pattern(/^[a-z]+$/);
    expect(validate(schema, 'ab').issues).toBeDefined();
    expect(validate(schema, 'abcdef').issues).toBeDefined();
    expect(validate(schema, 'AB').issues).toBeDefined();
    expect(validate(schema, 'abc').issues).toBeUndefined();
  });
});

describe('builtinT.number', () => {
  test('accepts finite numbers, rejects non-finite and non-numbers', () => {
    expect(validate(builtinT.number, 5).issues).toBeUndefined();
    expect(validate(builtinT.number, Number.POSITIVE_INFINITY).issues).toBeDefined();
    expect(validate(builtinT.number, Number.NaN).issues).toBeDefined();
    expect(validate(builtinT.number, '5').issues).toBeDefined();
  });

  test('min/max/int chain onto a new schema without mutating the original', () => {
    const withMin = builtinT.number.min(5);
    expect(withMin.node.minimum).toBe(5);
    expect(builtinT.number.node.minimum).toBeUndefined();

    const withMax = builtinT.number.max(10);
    expect(withMax.node.maximum).toBe(10);
    expect(builtinT.number.node.maximum).toBeUndefined();

    const withInt = builtinT.number.int();
    expect(withInt.node.integer).toBe(true);
    expect(builtinT.number.node.integer).toBeUndefined();
  });

  test('enforces min/max/int once chained', () => {
    const schema = builtinT.number.min(1).max(10).int();
    expect(validate(schema, 0).issues).toBeDefined();
    expect(validate(schema, 11).issues).toBeDefined();
    expect(validate(schema, 5.5).issues).toBeDefined();
    expect(validate(schema, 5).issues).toBeUndefined();
  });

  // The defect `money-value.ts` already carries the write-up for fixing one file over, in the
  // validator every `t.number.int()` field on every action goes through. 2^53 IS a whole number,
  // so `Number.isInteger` accepted it at the boundary, the policy gate and the handler ran, and
  // the row write refused it as a 500 — the same value refused twice, once with a field path and
  // once without.
  test('int() demands a SAFE integer, not merely a whole one', () => {
    const int = builtinT.number.int();
    expect(validate(int, Number.MAX_SAFE_INTEGER).issues).toBeUndefined();
    expect(validate(int, -Number.MAX_SAFE_INTEGER).issues).toBeUndefined();
    expect(validate(int, 2 ** 53).issues).toBeDefined();
    expect(validate(int, -(2 ** 53)).issues).toBeDefined();
    expect(validate(int, 2 ** 53 + 2).issues).toBeDefined();
  });

  // The message states the rule that fired, because `expected an integer` is false about a value
  // that IS one — and it still names no part of the value, which is `describe-value.ts`'s rule.
  test('the refusal names the rule, and never the value', () => {
    const message = validate(builtinT.number.int(), 2 ** 53).issues?.[0]?.message;
    expect(message).toBe('expected a safe integer, received a number');
    expect(message).not.toContain('9007199254740992');
  });
});

describe('builtinT.boolean', () => {
  test('accepts booleans only', () => {
    expect(validate(builtinT.boolean, true).issues).toBeUndefined();
    expect(validate(builtinT.boolean, false).issues).toBeUndefined();
    expect(validate(builtinT.boolean, 'true').issues).toBeDefined();
  });
});

describe('builtinT.uuid', () => {
  test('accepts a valid uuid', () => {
    expect(validate(builtinT.uuid, UUID).issues).toBeUndefined();
  });

  test('rejects a malformed uuid', () => {
    expect(validate(builtinT.uuid, 'not-a-uuid').issues).toBeDefined();
    expect(validate(builtinT.uuid, '018f4a1c-1b2c-7d3e-8f90-abcdef01234').issues).toBeDefined();
  });
});

describe('builtinT.email', () => {
  test('accepts a valid email address', () => {
    expect(validate(builtinT.email, 'dev@tesote.com').issues).toBeUndefined();
  });

  test('rejects a malformed email address', () => {
    expect(validate(builtinT.email, 'not-an-email').issues).toBeDefined();
    expect(validate(builtinT.email, 'missing-domain@').issues).toBeDefined();
  });
});

describe('builtinT.url', () => {
  test('accepts a valid absolute URL', () => {
    expect(validate(builtinT.url, 'https://example.com/path').issues).toBeUndefined();
  });

  test('rejects a relative path', () => {
    expect(validate(builtinT.url, '/path/to/thing').issues).toBeDefined();
  });
});

describe('builtinT.date', () => {
  test('accepts a Date, an ISO string and a timestamp number', () => {
    expect(validate(builtinT.date, new Date('2024-01-01')).issues).toBeUndefined();
    expect(validate(builtinT.date, '2024-01-01T00:00:00.000Z').issues).toBeUndefined();
    expect(validate(builtinT.date, Date.now()).issues).toBeUndefined();
  });

  test('an invalid Date instance fails gracefully instead of throwing', () => {
    // `expected()` -> `describeValue()` used to call `.toISOString()` unconditionally, which
    // throws a RangeError for an invalid Date — this asserts the fixed, graceful behavior.
    const result = validate(builtinT.date, new Date('not-a-date'));
    expect(result.issues).toBeDefined();
    expect(result.issues?.[0]?.message).toContain('invalid Date');
  });

  test('rejects a string that produces NaN when parsed', () => {
    expect(validate(builtinT.date, 'definitely not a date').issues).toBeDefined();
  });

  test('rejects other types entirely', () => {
    expect(validate(builtinT.date, true).issues).toBeDefined();
    expect(validate(builtinT.date, null).issues).toBeDefined();
  });

  test('refuses a zone-less date-time: one wire value must not be two instants', () => {
    // `new Date('2026-08-19T10:00')` resolves through the HOST process's zone — 14:00Z on a
    // TZ=America/New_York pod, 10:00Z on a TZ=UTC one, from the identical request.
    for (const zoneless of ['2026-08-19T10:00', '2026-08-19T10:00:00.500', '2026-08-19 10:00:00']) {
      const result = validate(builtinT.date, zoneless);
      expect(result.issues?.[0]?.message).toContain('an offset or Z');
    }
  });

  test('a date-only form still passes — no clock time, and UTC by specification', () => {
    const result = validate(builtinT.date, '2026-08-19');
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value.toISOString()).toBe('2026-08-19T00:00:00.000Z');
    }
  });

  test('an offset or Z names its own instant, so both are accepted', () => {
    expect(validate(builtinT.date, '2026-08-19T10:00:00Z').issues).toBeUndefined();
    expect(validate(builtinT.date, '2026-08-19T10:00:00-04:00').issues).toBeUndefined();
    expect(validate(builtinT.date, '2026-08-19T10:00-04:00').issues).toBeUndefined();
  });
});

/**
 * **A MIRROR of `isValidTimeZone`'s corpus in `packages/time/src/zones.test.ts`, name for name, and
 * it must move with it.**
 *
 * There is no longer a third statement to mirror: `@ultimat3/core` re-exports THIS predicate over
 * the declared `core -> schema` edge `As of 2026-08-27`, so the config validator and `t.timezone`
 * are one function and `timezone-validator-pin.test.ts` is deleted. `@ultimat3/time`'s
 * `canonicalTimeZone` remains its own, because it answers the canonical SPELLING with a memo a
 * request header can hit — a different question with a different cost.
 *
 * This is the local half of that comparison, and the reason it is not merely a pin: this predicate
 * is the one that judges **caller input** — `t.timezone` is a field on a request body, so a name
 * accepted here reaches a `format` call that refuses it.
 */
describe('builtinT.timezone', () => {
  test('accepts a valid IANA time zone', () => {
    expect(validate(builtinT.timezone, 'America/New_York').issues).toBeUndefined();
  });

  test('rejects an unknown time zone', () => {
    expect(validate(builtinT.timezone, 'Not/AZone').issues).toBeDefined();
  });

  // ICU 78 (Bun 1.4) RESOLVES every one of these where ICU 75 threw, which is how the bare `Intl`
  // probe this replaced started accepting them. One case per name, named, so a later ICU bump that
  // reopens one fails with the name in the report.
  const ABBREVIATIONS = [
    'CET',
    'EET',
    'MET',
    'WET',
    'EST',
    'MST',
    'HST',
    'GMT',
    'GMT0',
    'UCT',
    'Zulu',
    'EST5EDT',
    'CST6CDT',
    'MST7MDT',
    'PST8PDT',
  ];

  test.each(ABBREVIATIONS)('refuses %s — an abbreviation carries no DST rule', (zone) => {
    expect(validate(builtinT.timezone, zone).issues).toBeDefined();
    // Every casing, because `Intl` accepts every casing of every name it accepts at all.
    expect(validate(builtinT.timezone, zone.toLowerCase()).issues).toBeDefined();
  });

  // Single-label `backward` links name real zones, and refusing them is deliberate rather than ICU
  // drift: no structural rule keeps `CET` out and lets `Japan` in, both being one label.
  test.each(['Japan', 'GB', 'Eire', 'W-SU', 'PRC', 'ROK', 'Singapore', 'Israel', 'Universal'])(
    'refuses the single-label legacy link %s',
    (zone) => {
      expect(validate(builtinT.timezone, zone).issues).toBeDefined();
    },
  );

  // A fixed offset has no DST rules, and ES2024 `Intl` accepted these long before ICU 78 — so this
  // class has been reaching `t.timezone` off the wire under every runtime this framework has
  // shipped on, which is what makes this the worst of the three sites.
  test.each(['+01:00', '-05:00', '+0100', '-08'])('refuses the bare offset %s', (zone) => {
    expect(validate(builtinT.timezone, zone).issues).toBeDefined();
  });

  test.each(['Europe/Berlin', 'UTC', 'utc', 'US/Eastern', 'Asia/Calcutta', 'Etc/GMT+2'])(
    'still accepts %s',
    (zone) => {
      expect(validate(builtinT.timezone, zone).issues).toBeUndefined();
    },
  );

  test.each(['', ' ', 'Mars/Olympus', 'Europe/Berlin ', 'Not a zone'])(
    'refuses %p, which is not a zone at all',
    (zone) => {
      expect(validate(builtinT.timezone, zone).issues).toBeDefined();
    },
  );

  /**
   * The other direction, and the reason it is not just a longer hardcoded list: the rule must be
   * exactly as wide as the runtime's own canonical set, and nothing in the corpus above would
   * notice a rule that narrowed — `/^[A-Za-z_]+\/[A-Za-z_]+$/` refuses
   * `America/Argentina/Buenos_Aires` and `Etc/GMT+2` while passing every case above it.
   */
  test('accepts every zone the runtime itself lists, three-part and signed names included', () => {
    const listed = Intl.supportedValuesOf('timeZone');
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.filter((zone) => validate(builtinT.timezone, zone).issues !== undefined)).toEqual(
      [],
    );
    expect(listed).toContain('America/Argentina/Buenos_Aires');
  });
});

describe('builtinT.locale', () => {
  test('accepts a valid BCP-47 locale', () => {
    expect(validate(builtinT.locale, 'es-419').issues).toBeUndefined();
  });

  test('rejects a malformed locale tag', () => {
    expect(validate(builtinT.locale, '!!!not-a-locale!!!').issues).toBeDefined();
  });
});

describe('builtinT.slug', () => {
  test('accepts a lowercase-hyphenated slug', () => {
    expect(validate(builtinT.slug, 'hello-world').issues).toBeUndefined();
  });

  test('rejects spaces, uppercase and leading/trailing hyphens', () => {
    expect(validate(builtinT.slug, 'Hello World').issues).toBeDefined();
    expect(validate(builtinT.slug, '-hello').issues).toBeDefined();
    expect(validate(builtinT.slug, 'hello--world').issues).toBeDefined();
  });
});

describe('builtinT.cursor', () => {
  test('accepts a base64url-ish opaque cursor', () => {
    expect(validate(builtinT.cursor, 'abc123_-XYZ').issues).toBeUndefined();
  });

  test('rejects characters outside the base64url alphabet', () => {
    expect(validate(builtinT.cursor, 'abc 123').issues).toBeDefined();
    expect(validate(builtinT.cursor, 'abc+123').issues).toBeDefined();
  });
});
