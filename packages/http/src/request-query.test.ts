// The query half of `UltimateRequest`: `queryRaw()`'s parse and `query()`'s refusal. Split out of
// `request.test.ts` when that file reached the 500-line ceiling, along the seam the parse already
// has — everything here is about the ONE object built from `url.searchParams`, which is the only
// attacker-shaped input a handler reads without a body.
import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { defineHttpConfig } from './config';
import { createRequestContext } from './context';
import { HttpError } from './errors';
import { UltimateRequest } from './request';
import type { Schema } from './validate';

/** A GET at `urlString`, with the smallest context the query path reads. */
const build = (urlString: string) => {
  const url = new URL(urlString);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
  return { req: new UltimateRequest(new Request(url), ctx) };
};

/** An OWN property's value, read without the `__proto__` accessor the parse must not have. */
const ownValue = (source: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(source, key)?.value;

/** A call that does not throw leaves this `undefined`, which fails the caller's `?.code`. */
const captureSyncError = (run: () => unknown): HttpError | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  return undefined;
};

describe('queryRaw()', () => {
  test('a single key becomes a plain string', () => {
    const { req } = build('https://example.com/x?a=1');
    expect(req.queryRaw()).toEqual({ a: '1' });
  });

  test('a repeated key becomes an array, in order', () => {
    const { req } = build('https://example.com/x?a=1&a=2');
    expect(req.queryRaw()).toEqual({ a: ['1', '2'] });
  });

  test('no query string returns an empty object', () => {
    const { req } = build('https://example.com/x');
    expect(req.queryRaw()).toEqual({});
  });

  // ONE occurrence was enough, not two: `out['__proto__']` on a plain `{}` never reads as
  // `undefined` — it reads the inherited `Object.prototype` — so the very first `?__proto__=`
  // took the repeated-key branch and assigned an ARRAY through the `__proto__` setter, which
  // accepts an object and replaced this object's prototype with it. The parsed query came back
  // inheriting `length`, `push` and index keys "0"/"1" the caller never sent, and the parameter
  // itself was swallowed. `Object.create(null)` has no such setter and no such getter.
  test('one ?__proto__= cannot reach the parsed object’s prototype', () => {
    const { req } = build('https://example.com/x?__proto__=polluted');
    const parsed = req.queryRaw();
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.keys(parsed)).toEqual(['__proto__']);
    // The descriptor, not `parsed.__proto__`: reading the own DATA property is the assertion, and
    // the dotted form is the accessor this test exists to prove is gone (biome `noProto` agrees).
    expect(ownValue(parsed, '__proto__')).toBe('polluted');
    const enumerated: string[] = [];
    for (const key in parsed) enumerated.push(key);
    expect(enumerated).toEqual(['__proto__']);
  });

  test('a repeated ?__proto__= is an array like any other repeated key', () => {
    const { req } = build('https://example.com/x?__proto__=a&__proto__=b');
    const parsed = req.queryRaw();
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(ownValue(parsed, '__proto__')).toEqual(['a', 'b']);
  });

  // The other half of a plain `{}`, and the one a schema sees: `coerceQuery` decides whether to
  // coerce a declared property with `key in record`, and every `Object.prototype` member answered
  // true — so a schema declaring `toString` or `constructor` coerced an inherited function that
  // no request ever carried.
  test('no key the caller did not send is `in` the parsed query', () => {
    const { req } = build('https://example.com/x?a=1');
    const parsed = req.queryRaw();
    expect('toString' in parsed).toBe(false);
    expect('constructor' in parsed).toBe(false);
    expect('a' in parsed).toBe(true);
  });
});

describe('query()', () => {
  test('a valid query parses through a real schema', () => {
    const { req } = build('https://example.com/x?page=2');
    const schema = t.object({ page: t.string });
    expect(req.query(schema)).toEqual({ page: '2' });
  });

  test('an invalid query throws X_BODY_INVALID with issues', () => {
    const { req } = build('https://example.com/x');
    const schema = t.object({ page: t.string });
    const error = captureSyncError(() => req.query(schema));
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause.length).toBeGreaterThan(0);
  });

  test('a schema with controlled issues surfaces them verbatim in the cause', () => {
    const { req } = build('https://example.com/x?a=1');
    const schema: Schema<never> = {
      '~standard': {
        version: 1,
        vendor: 'ultimate-test',
        validate: () => ({ issues: [{ message: 'must be a widget', path: ['a'] }] }),
      },
    };
    const error = captureSyncError(() => req.query(schema));
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('a: must be a widget');
  });

  // What the caller did with a failure result read as success: `query()`'s return type says `Out`,
  // so the handler indexed the `undefined` it was handed and the TypeError surfaced as X_INTERNAL
  // — a 500, reported to the on-call monitor, for a request that was simply invalid.
  test('a schema that fails with no issues is a refusal, never an undefined value', () => {
    const { req } = build('https://example.com/x?a=1');
    const schema: Schema<{ a: string }> = {
      '~standard': {
        version: 1,
        vendor: 'ultimate-test',
        validate: () => ({ issues: [] }),
      },
    };
    const error = captureSyncError(() => req.query(schema));
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause.length).toBeGreaterThan(0);
  });
});
