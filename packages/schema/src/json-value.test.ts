// Single responsibility: pins `t.json()`'s accept/refuse contract at the public `validate()` seam,
// its issue PATHS (positions, never caller keys), cycles, the depth bound and its projections.

import { describe, expect, test } from 'bun:test';
import { coerceNode } from './coerce';
import { toJsonSchema } from './json-schema';
import { JSON_MAX_DEPTH, type JsonValue, jsonSchema } from './json-value';
import { fits } from './node-fits';
import { formatIssues, validate } from './standard';
import { t } from './t';
import { objectSchema } from './validators';
import { toWireSchema } from './wire-schema';

const json = t.json();

/** The issues of a refused value as `path: message` lines, or a failure if it was accepted. */
function refusal(value: unknown): readonly string[] {
  const result = validate(json, value);
  if (result.issues === undefined) return expect.unreachable('the value was accepted');
  return formatIssues(result.issues);
}

function accepted(value: unknown): unknown {
  const result = validate(json, value);
  if (result.issues !== undefined) {
    return expect.unreachable(`refused: ${formatIssues(result.issues).join('; ')}`);
  }
  return result.value;
}

/** `depth` containers, each holding the next: depth 1 is `[]`. */
function nested(depth: number): unknown {
  let value: unknown = [];
  for (let level = 1; level < depth; level += 1) value = [value];
  return value;
}

describe('t.json() accepts every JSON value', () => {
  const cases: readonly [string, unknown][] = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['a negative float', -12.5],
    ['an integer past 2^53', 2 ** 60],
    ['an empty string', ''],
    ['an astral string', '👍 ok'],
    ['an empty array', []],
    ['an empty object', {}],
    ['a null-prototype object', Object.assign(Object.create(null) as object, { a: 1 })],
    ['a nested document', { a: [1, 'two', { three: [null, true] }], b: { c: {} } }],
  ];
  for (const [name, value] of cases) {
    test(name, () => {
      expect(accepted(value)).toEqual(value as JsonValue);
    });
  }

  test('round-trips byte-identically through JSON.stringify', () => {
    const doc = { z: 1, a: [1, { b: 'x' }], m: null };
    expect(JSON.stringify(accepted(doc))).toBe(JSON.stringify(doc));
  });

  test('every key is data, `__proto__` and `constructor` included, and stays an own key', () => {
    const parsed = accepted(JSON.parse('{"__proto__":{"admin":true},"constructor":1}'));
    expect(Object.keys(parsed as object)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect((parsed as Record<string, unknown>)['admin']).toBeUndefined();
  });

  test('answers a copy, so a getter is read once and the input can be mutated after', () => {
    let reads = 0;
    const input = {
      get n() {
        reads += 1;
        return reads;
      },
    };
    const parsed = accepted(input) as Record<string, unknown>;
    expect(reads).toBe(1);
    expect(parsed['n']).toBe(1);
    expect(parsed).not.toBe(input);
  });

  test('a value shared twice (not a cycle) is accepted at both positions', () => {
    const shared = { k: [1, 2] };
    expect(accepted({ a: shared, b: [shared] })).toEqual({ a: shared, b: [shared] });
  });

  test('a shared value is walked once, so a DAG of 2^24 paths is linear, not exponential', () => {
    let value: unknown = [];
    for (let level = 0; level < 24; level += 1) value = [value, value];
    const started = performance.now();
    expect(validate(json, value).issues).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('t.json() refuses what JSON cannot carry, naming the shape only', () => {
  const cases: readonly [string, unknown, string][] = [
    ['undefined', undefined, 'received undefined'],
    ['a function', () => 1, 'received a function'],
    ['a symbol', Symbol('s'), 'received a symbol'],
    ['a bigint', 1n, 'received a bigint'],
    ['NaN', Number.NaN, 'received NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'received Infinity'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'received -Infinity'],
    ['a Date', new Date(0), 'received a Date'],
    ['a Map', new Map([['a', 1]]), 'not a plain object'],
    ['a Set', new Set([1]), 'not a plain object'],
    ['a class instance', new (class Point {})(), 'not a plain object'],
    ['a typed array', new Uint8Array(2), 'not a plain object'],
    ['a NUL in a string', 'a\u0000b', 'NUL character (U+0000)'],
    ['a lone surrogate', 'a\uD800b', 'lone UTF-16 surrogate'],
  ];
  for (const [name, value, fragment] of cases) {
    test(name, () => {
      const lines = refusal(value);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(fragment);
    });
  }

  test('a refused string is described, never echoed', () => {
    expect(refusal('hunter2\u0000').join()).not.toContain('hunter2');
  });
});

describe('t.json() issue paths are positions the framework chose, never caller keys', () => {
  test('an array element is named by its index', () => {
    expect(refusal([1, 2, undefined])).toEqual(['[2]: expected a JSON value, received undefined']);
  });

  test("an object entry is named by its POSITION, so the caller's key never reaches the log", () => {
    const lines = refusal({ 'ssn-123-45-6789': 1, secret: Number.NaN });
    expect(lines).toEqual(['[1]: expected a JSON value, received NaN']);
    expect(lines.join()).not.toContain('secret');
  });

  test('a declared t.object field stays named, and the JSON beneath it is positional', () => {
    const body = objectSchema({ payload: json });
    const result = validate(body, { payload: { a: { deep: [0, () => 0] } } });
    expect(formatIssues(result.issues ?? [])).toEqual([
      'payload[0][0][1]: expected a JSON value, received a function',
    ]);
  });

  test('a bad KEY is refused at its position without quoting it', () => {
    const lines = refusal({ ok: 1, 'pass\u0000word': 2 });
    expect(lines).toEqual([
      '[1]: expected an object key, received one that contains a NUL character (U+0000)',
    ]);
    const surrogate = refusal({ ['k\uDC00']: 2 });
    expect(surrogate).toEqual([
      '[0]: expected an object key, received one that contains a lone UTF-16 surrogate',
    ]);
  });

  test('every bad member is reported, not only the first', () => {
    expect(refusal([undefined, 1, Number.NaN])).toHaveLength(2);
  });

  test('a sparse array hole is undefined, and refused at its index', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole IS the input under test.
    expect(refusal([1, , 3])).toEqual(['[1]: expected a JSON value, received undefined']);
  });
});

describe('t.json() refuses cycles', () => {
  test('an object that contains itself is refused at the back-reference', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop['self'] = loop;
    expect(refusal(loop)).toEqual([
      '[1]: expected a JSON value, received a cycle (a reference back to an enclosing value)',
    ]);
  });

  test('a cycle through an array is refused at the array position', () => {
    const list: unknown[] = [];
    list.push({ back: list });
    expect(refusal(list)).toEqual([
      '[0][0]: expected a JSON value, received a cycle (a reference back to an enclosing value)',
    ]);
  });

  test('a refused shared value fails the parse once, not once per reference', () => {
    const bad = { f: Number.NaN };
    expect(refusal([bad, bad])).toEqual(['[0][0]: expected a JSON value, received NaN']);
  });
});

describe('t.json() is bounded in depth', () => {
  test(`accepts exactly ${JSON_MAX_DEPTH} nested containers`, () => {
    expect(validate(json, nested(JSON_MAX_DEPTH)).issues).toBeUndefined();
  });

  test('refuses one more, at the container that crossed the bound', () => {
    const lines = refusal(nested(JSON_MAX_DEPTH + 1));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEndWith(
      `: expected JSON nested at most ${JSON_MAX_DEPTH} levels deep, received an empty array`,
    );
    expect(lines[0]?.match(/\[0\]/g)).toHaveLength(JSON_MAX_DEPTH);
  });

  test('a nesting deep enough to overflow a recursive walk is an issue, not a RangeError', () => {
    expect(() => validate(json, nested(100_000))).not.toThrow();
  });

  test('a shared value reused deeper than the bound allows is refused there', () => {
    const tall = nested(JSON_MAX_DEPTH - 1);
    // Accepted at depth 1 (inside the root array), then met again two levels further down.
    expect(refusal([tall, [[tall]]])).toHaveLength(1);
  });
});

describe('t.json() projections', () => {
  test('JSON Schema: any JSON value, with the bound the parser enforces stated', () => {
    expect(toJsonSchema(json, { includeDialect: false })).toEqual({
      description: `any JSON value, nested at most ${JSON_MAX_DEPTH} levels deep`,
    });
  });

  test('a described json keeps the author note first', () => {
    expect(toJsonSchema(json.describe('webhook body'), { includeDialect: false })).toEqual({
      description: `webhook body — any JSON value, nested at most ${JSON_MAX_DEPTH} levels deep`,
    });
  });

  test('a field of an object projects to the same document inside properties', () => {
    const body = toJsonSchema(objectSchema({ payload: json }), { includeDialect: false });
    expect(body.properties?.['payload']).toEqual({
      description: `any JSON value, nested at most ${JSON_MAX_DEPTH} levels deep`,
    });
  });

  test('MCP tool schema: no type, so an agent may send any JSON there', () => {
    const wire = toWireSchema(objectSchema({ payload: json }));
    expect(wire.properties?.['payload']).toEqual({
      description: `any JSON value, nested at most ${JSON_MAX_DEPTH} levels deep`,
    });
  });

  test('the IR names it, so a generator can tell JSON from "the IR cannot say"', () => {
    expect(json.node).toEqual({ kind: 'json' });
    expect(jsonSchema().node).toEqual({ kind: 'json' });
  });

  test('HTTP coercion leaves a raw value alone: a query string is already a JSON string', () => {
    expect(coerceNode(json.node, '12')).toBe('12');
  });

  test('a union member fits any JSON shape, one level deep', () => {
    expect(fits(json.node, { a: 1 })).toBe(true);
    expect(fits(json.node, [1])).toBe(true);
    expect(fits(json.node, 'x')).toBe(true);
    expect(fits(json.node, null)).toBe(true);
    expect(fits(json.node, new Date())).toBe(false);
    expect(fits(json.node, Number.NaN)).toBe(false);
  });

  test('.nullable(), .optional() and .default() compose', () => {
    expect(validate(t.json().optional(), undefined).issues).toBeUndefined();
    expect(t.json().default({ a: [] }).parse(undefined)).toEqual({ a: [] });
    expect(() => t.json().default(Number.NaN as JsonValue)).toThrow(/X_SCHEMA_DEFAULT_INVALID/);
  });
});
