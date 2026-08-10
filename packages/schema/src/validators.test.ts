import { describe, expect, test } from 'bun:test';
import { validate } from './standard';
import {
  arraySchema,
  builtinT,
  enumSchema,
  literalSchema,
  nullableSchema,
  objectSchema,
  optionalSchema,
  recordSchema,
  unionSchema,
} from './validators';

const UUID = '018f4a1c-1b2c-7d3e-8f90-abcdef012345';

describe('objectSchema', () => {
  test('accepts a valid object', () => {
    const schema = objectSchema({ id: builtinT.uuid, name: builtinT.string });
    const result = validate(schema, { id: UUID, name: 'ok' });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual({ id: UUID, name: 'ok' });
  });

  test('drops unknown keys so an action cannot be mass-assigned', () => {
    const schema = objectSchema({ id: builtinT.uuid });
    const result = validate(schema, { id: UUID, isAdmin: true });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value).toEqual({ id: UUID });
      expect('isAdmin' in result.value).toBe(false);
    }
  });

  test('rejects non-objects, including arrays', () => {
    const schema = objectSchema({ id: builtinT.uuid });
    const result = validate(schema, ['not', 'an', 'object']);
    expect(result.issues?.[0]?.message).toContain('expected an object');
  });

  test('aggregates issues across every invalid field, each with its own path', () => {
    const schema = objectSchema({ a: builtinT.string, b: builtinT.number });
    const result = validate(schema, { a: '', b: 'not a number' });
    expect(result.issues?.length).toBe(2);
    expect(result.issues?.[0]?.path).toEqual(['a']);
    expect(result.issues?.[1]?.path).toEqual(['b']);
  });

  test('omits undefined member values from the output entirely', () => {
    const schema = objectSchema({ a: optionalSchema(builtinT.string) });
    const result = validate(schema, {});
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(Object.keys(result.value)).toEqual([]);
      expect('a' in result.value).toBe(false);
    }
  });

  test('extend adds fields to the shape and to validation', () => {
    const base = objectSchema({ id: builtinT.uuid });
    const extended = base.extend({ title: builtinT.string });
    expect(Object.keys(extended.shape).sort()).toEqual(['id', 'title']);
    const result = validate(extended, { id: UUID, title: 'hi' });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual({ id: UUID, title: 'hi' });
  });

  test('pick keeps only the named fields, dropping the rest even when present', () => {
    const base = objectSchema({ id: builtinT.uuid, secret: builtinT.string });
    const picked = base.pick('id');
    expect(Object.keys(picked.shape)).toEqual(['id']);
    const result = validate(picked, { id: UUID, secret: 'nope' });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual({ id: UUID });
  });

  test('omit drops the named fields, keeping the rest', () => {
    const base = objectSchema({ id: builtinT.uuid, secret: builtinT.string });
    const rest = base.omit('secret');
    expect(Object.keys(rest.shape)).toEqual(['id']);
    const result = validate(rest, { id: UUID });
    expect(result.issues).toBeUndefined();
  });
});

describe('arraySchema', () => {
  test('accepts a valid array', () => {
    const schema = arraySchema(builtinT.number);
    const result = validate(schema, [1, 2, 3]);
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual([1, 2, 3]);
  });

  test('rejects non-arrays', () => {
    const schema = arraySchema(builtinT.number);
    const result = validate(schema, 'not an array');
    expect(result.issues?.[0]?.message).toContain('expected an array');
  });

  test('tags each failing item with its index path and aggregates across items', () => {
    const schema = arraySchema(builtinT.number);
    const result = validate(schema, [1, 'bad', 3, 'also bad']);
    expect(result.issues?.length).toBe(2);
    expect(result.issues?.[0]?.path).toEqual([1]);
    expect(result.issues?.[1]?.path).toEqual([3]);
  });
});

describe('enumSchema / builtinT.enumerated', () => {
  test('accepts a member value', () => {
    const schema = enumSchema(['draft', 'published']);
    const result = validate(schema, 'draft');
    expect(result.issues).toBeUndefined();
  });

  test('rejects a non-member value', () => {
    const schema = enumSchema(['draft', 'published']);
    const result = validate(schema, 'archived');
    expect(result.issues?.[0]?.message).toBe(
      'expected one of draft | published, received "archived"',
    );
  });

  test('enumerated is the variadic spelling of enum', () => {
    const schema = builtinT.enumerated('a', 'b', 'c');
    expect(validate(schema, 'b').issues).toBeUndefined();
    expect(validate(schema, 'z').issues).toBeDefined();
  });
});

describe('literalSchema', () => {
  test('matches the exact value', () => {
    const schema = literalSchema('post');
    expect(validate(schema, 'post').issues).toBeUndefined();
  });

  test('rejects a different value of the same type', () => {
    const schema = literalSchema('post');
    expect(validate(schema, 'page').issues).toBeDefined();
  });

  test('is type-sensitive: 1 does not match "1"', () => {
    const schema = literalSchema(1);
    expect(validate(schema, 1).issues).toBeUndefined();
    expect(validate(schema, '1').issues).toBeDefined();
  });
});

describe('unionSchema', () => {
  test('first matching member wins, including its own transformation', () => {
    const schema = unionSchema(builtinT.date, builtinT.string);
    const result = validate(schema, '2024-01-01T00:00:00.000Z');
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toBeInstanceOf(Date);
  });

  test('falls through to a later member when earlier ones fail', () => {
    const schema = unionSchema(builtinT.uuid, builtinT.slug);
    const result = validate(schema, 'hello-world');
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toBe('hello-world');
  });

  test('aggregates every member reason when nothing matches', () => {
    const schema = unionSchema(builtinT.uuid, builtinT.email);
    const result = validate(schema, 'nope');
    expect(result.issues?.length).toBe(1);
    const message = result.issues?.[0]?.message ?? '';
    expect(message).toContain('no union member matched');
    expect(message).toContain('uuid');
    expect(message).toContain('email');
  });
});

describe('recordSchema', () => {
  test('accepts a valid record', () => {
    const schema = recordSchema(builtinT.number);
    const result = validate(schema, { a: 1, b: 2 });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual({ a: 1, b: 2 });
  });

  test('rejects non-objects', () => {
    const schema = recordSchema(builtinT.number);
    expect(validate(schema, [1, 2]).issues).toBeDefined();
  });

  test('tags each failing entry with its key path and aggregates across entries', () => {
    const schema = recordSchema(builtinT.number);
    const result = validate(schema, { a: 1, b: 'bad', c: 3, d: 'also bad' });
    expect(result.issues?.length).toBe(2);
    expect(result.issues?.[0]?.path).toEqual(['b']);
    expect(result.issues?.[1]?.path).toEqual(['d']);
  });
});

describe('nullableSchema', () => {
  test('accepts null', () => {
    const schema = nullableSchema(builtinT.string);
    expect(validate(schema, null).issues).toBeUndefined();
  });

  test('otherwise delegates to the underlying schema', () => {
    const schema = nullableSchema(builtinT.string);
    expect(validate(schema, 'ok').issues).toBeUndefined();
    expect(validate(schema, 42).issues).toBeDefined();
  });
});

describe('optionalSchema', () => {
  test('accepts undefined', () => {
    const schema = optionalSchema(builtinT.number);
    expect(validate(schema, undefined).issues).toBeUndefined();
  });

  test('otherwise delegates to the underlying schema', () => {
    const schema = optionalSchema(builtinT.number);
    expect(validate(schema, 5).issues).toBeUndefined();
    expect(validate(schema, 'nope').issues).toBeDefined();
  });
});

describe('builtinT.string', () => {
  test('rejects an empty string by default', () => {
    expect(validate(builtinT.string, '').issues).toBeDefined();
  });

  test('rejects non-strings', () => {
    expect(validate(builtinT.string, 123).issues).toBeDefined();
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
    expect(result.issues?.[0]?.message).toContain('Invalid Date');
  });

  test('rejects a string that produces NaN when parsed', () => {
    expect(validate(builtinT.date, 'definitely not a date').issues).toBeDefined();
  });

  test('rejects other types entirely', () => {
    expect(validate(builtinT.date, true).issues).toBeDefined();
    expect(validate(builtinT.date, null).issues).toBeDefined();
  });
});

describe('builtinT.money', () => {
  test('accepts a valid Money value', () => {
    const result = validate(builtinT.money, { minor: 1999, currency: 'EUR' });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual({ minor: 1999, currency: 'EUR' });
  });

  test('rejects a non-integer minor amount', () => {
    const result = validate(builtinT.money, { minor: 19.99, currency: 'EUR' });
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.path).toEqual(['minor']);
  });

  test('rejects a malformed currency code', () => {
    const result = validate(builtinT.money, { minor: 1999, currency: 'eur' });
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.path).toEqual(['currency']);
  });

  test('reports both issues together when minor and currency are both invalid', () => {
    const result = validate(builtinT.money, { minor: 19.99, currency: 'eur' });
    expect(result.issues?.length).toBe(2);
    expect(result.issues?.map((issue) => issue.path)).toEqual([['minor'], ['currency']]);
  });

  test('rejects a non-object', () => {
    expect(validate(builtinT.money, 'money').issues).toBeDefined();
  });
});

describe('builtinT.timezone', () => {
  test('accepts a valid IANA time zone', () => {
    expect(validate(builtinT.timezone, 'America/New_York').issues).toBeUndefined();
  });

  test('rejects an unknown time zone', () => {
    expect(validate(builtinT.timezone, 'Not/AZone').issues).toBeDefined();
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
