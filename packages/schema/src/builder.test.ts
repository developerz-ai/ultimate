import { describe, expect, test } from 'bun:test';
import { checkOf, describeValue, expected, fail, failWith, makeSchema, pass } from './builder';
import { ValidationFailedError } from './errors';
import type { SchemaNode } from './node';

describe('pass', () => {
  test('shape', () => {
    expect(pass('ok')).toEqual({ ok: true, value: 'ok' });
  });
});

describe('fail', () => {
  test('shape', () => {
    expect(fail(['a', 0], 'bad')).toEqual({
      ok: false,
      issues: [{ message: 'bad', path: ['a', 0] }],
    });
  });

  test('copies the path array rather than reusing the reference', () => {
    const path = ['a'];
    const result = fail(path, 'bad');
    path.push('mutated');
    expect(result.issues[0]?.path).toEqual(['a']);
  });
});

describe('failWith', () => {
  test('passes issues through unchanged', () => {
    const issues = [{ message: 'bad', path: ['x'] }];
    expect(failWith(issues)).toEqual({ ok: false, issues });
  });
});

describe('expected', () => {
  test('renders "expected X, received Y"', () => {
    expect(expected('a uuid', 'abc')).toBe('expected a uuid, received "abc"');
    expect(expected('a number', undefined)).toBe('expected a number, received undefined');
  });
});

describe('describeValue', () => {
  test('undefined', () => {
    expect(describeValue(undefined)).toBe('undefined');
  });

  test('null', () => {
    expect(describeValue(null)).toBe('null');
  });

  test('string is JSON-quoted', () => {
    expect(describeValue('abc')).toBe('"abc"');
    expect(describeValue('a "quote"')).toBe(JSON.stringify('a "quote"'));
  });

  test('number and boolean use String()', () => {
    expect(describeValue(42)).toBe('42');
    expect(describeValue(true)).toBe('true');
    expect(describeValue(false)).toBe('false');
  });

  test('array renders as array(n)', () => {
    expect(describeValue([1, 2, 3])).toBe('array(3)');
    expect(describeValue([])).toBe('array(0)');
  });

  test('a valid Date renders as Date(<iso>)', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(describeValue(date)).toBe(`Date(${date.toISOString()})`);
  });

  test('an Invalid Date renders as Date(Invalid Date)', () => {
    expect(describeValue(new Date('not a date'))).toBe('Date(Invalid Date)');
  });

  test('a plain object renders as its typeof', () => {
    expect(describeValue({})).toBe('object');
    expect(describeValue({ a: 1 })).toBe('object');
  });
});

/** A trivial `SchemaNode` fixture for `makeSchema` tests below. */
const numberNode: SchemaNode = { kind: 'number' };

function makeNumberSchema() {
  return makeSchema<number, number>(numberNode, (value, path) =>
    typeof value === 'number' ? pass(value) : fail(path, expected('a number', value)),
  );
}

describe('makeSchema', () => {
  test('.parse() returns the value on success', () => {
    const schema = makeNumberSchema();
    expect(schema.parse(42)).toBe(42);
  });

  test('.parse() throws ValidationFailedError on failure', () => {
    const schema = makeNumberSchema();
    expect(() => schema.parse('nope')).toThrow(ValidationFailedError);
  });

  test('.safeParse() returns {value} or {issues} without throwing', () => {
    const schema = makeNumberSchema();
    expect(schema.safeParse(42)).toEqual({ value: 42 });
    const failed = schema.safeParse('nope');
    expect(failed.issues).toBeDefined();
    expect(failed.value).toBeUndefined();
  });

  test('["~standard"].validate() mirrors safeParse', () => {
    const schema = makeNumberSchema();
    expect(schema['~standard'].validate(42)).toEqual(schema.safeParse(42));
    expect(schema['~standard'].validate('nope')).toEqual(schema.safeParse('nope'));
  });

  test('.optional() short-circuits undefined to pass(undefined) without invoking the check', () => {
    const schema = makeNumberSchema();
    const optional = schema.optional();
    expect(optional.safeParse(undefined)).toEqual({ value: undefined });
    // the wrapped check would fail on a string, so a value passing here proves the
    // short-circuit ran instead of falling through to the original check.
    expect(optional.node.optional).toBe(true);
    // non-undefined values still go through the original check.
    expect(optional.safeParse('nope').issues).toBeDefined();
  });

  test('.nullable() short-circuits null to pass(null) without invoking the check', () => {
    const schema = makeNumberSchema();
    const nullable = schema.nullable();
    expect(nullable.safeParse(null)).toEqual({ value: null });
    expect(nullable.node.nullable).toBe(true);
    expect(nullable.safeParse('nope').issues).toBeDefined();
  });

  test('.default() bypasses the check for undefined and returns the fallback', () => {
    const schema = makeNumberSchema();
    const withDefault = schema.default(7);
    expect(withDefault.safeParse(undefined)).toEqual({ value: 7 });
    expect(withDefault.node.hasDefault).toBe(true);
    expect(withDefault.node.default).toBe(7);
    // non-undefined values still go through the original check.
    expect(withDefault.safeParse(42)).toEqual({ value: 42 });
  });

  test('.describe() sets node.description and leaves check behavior unchanged', () => {
    const schema = makeNumberSchema();
    const described = schema.describe('a count');
    expect(described.node.description).toBe('a count');
    expect(described.safeParse(42)).toEqual({ value: 42 });
    expect(described.safeParse('nope').issues).toBeDefined();
  });
});

describe('checkOf', () => {
  test('a passing value returns pass(value)', () => {
    const schema = makeNumberSchema();
    const check = checkOf(schema);
    expect(check(42, [])).toEqual(pass(42));
  });

  test('a failing value re-paths the schema issues with the caller path prefix', () => {
    const schema = makeNumberSchema();
    const check = checkOf(schema);
    const result = check('nope', ['parent', 'child']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toEqual(['parent', 'child']);
    }
  });

  test('an async schema returns fail(path, ...) instead of throwing', () => {
    const asyncSchema = makeSchema<number, number>(numberNode, (value, path) =>
      typeof value === 'number' ? pass(value) : fail(path, 'nope'),
    );
    // simulate an async "~standard".validate by wrapping it after the fact
    const wrapped = {
      ...asyncSchema,
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => Promise.resolve({ value: 1 }),
      },
    };
    const check = checkOf(wrapped);
    const result = check('anything', ['root']);
    expect(result).toEqual(fail(['root'], 'expected a synchronous schema, received an async one'));
  });
});
