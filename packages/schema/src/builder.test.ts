// Direct coverage for `builder.ts` — the result constructors, `makeSchema` and `refine`, which
// every `t.*` type in this package is assembled from. Exercised only indirectly until now, through
// the types built on it, so a drift in an issue's path surfaced as a puzzling failure in some
// other suite rather than here. Value rendering has its own file: `describe-value.test.ts`.

import { describe, expect, test } from 'bun:test';
import { checkOf, fail, failWith, makeSchema, pass } from './builder';
import { expected } from './describe-value';
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
    // `failed.value` is not a property to read: Standard Schema's failure result declares only
    // `issues`, so reading `.value` before narrowing is a compile error rather than `undefined`.
    // What the runtime must hold is that the key is absent — `{ value: undefined, issues }` would
    // satisfy the old assertion and break a caller that discriminates on `'value' in result`.
    expect(Object.hasOwn(failed, 'value')).toBe(false);
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

  test('.default() hands each parse its own object — never one shared reference', () => {
    // Cross-request data bleed: every request that omitted the field received the SAME array, so
    // one handler's `push` was the next request's starting value for the life of the process.
    const schema = makeSchema<unknown, string[]>({ kind: 'array' }, (value, path) =>
      Array.isArray(value) ? pass(value as string[]) : fail(path, 'expected an array'),
    ).default([]);

    const first = schema.parse(undefined);
    const second = schema.parse(undefined);
    expect(first).not.toBe(second);

    first.push('leaked');
    expect(schema.parse(undefined)).toEqual([]);
  });

  test('.default() keeps the DECLARED value on the node, for OpenAPI', () => {
    const declared = { retries: 3 };
    const schema = makeSchema<unknown, { retries: number }>({ kind: 'object' }, (value) =>
      pass(value as { retries: number }),
    ).default(declared);
    expect(schema.node.default).toEqual({ retries: 3 });
    expect(schema.node.hasDefault).toBe(true);
  });

  test('.default() refuses a fallback it cannot hand out a fresh copy of', () => {
    const schema = makeSchema<unknown, unknown>({ kind: 'unknown' }, (value) => pass(value));
    expect(() => schema.default({ onMiss: () => 1 })).toThrow(/X_SCHEMA_DEFAULT_UNSHAREABLE/);
  });

  test('.default(x).optional() publishes no default it cannot produce', () => {
    // `optional()` short-circuits `undefined` to `undefined` BEFORE the default is reached, so a
    // published `default: 20` described a value this schema never returns.
    const schema = makeNumberSchema().default(20).optional();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.node.hasDefault).toBeUndefined();
    expect('default' in schema.node).toBe(false);
  });

  test('.describe() sets node.description and leaves check behavior unchanged', () => {
    const schema = makeNumberSchema();
    const described = schema.describe('a count');
    expect(described.node.description).toBe('a count');
    expect(described.safeParse(42)).toEqual({ value: 42 });
    expect(described.safeParse('nope').issues).toBeDefined();
  });
});

describe('refine', () => {
  const positive = { name: 'positive', message: 'must be greater than zero' } as const;

  test('a failing predicate reports the rule, never the value it rejected', () => {
    const schema = makeNumberSchema().refine({ ...positive, check: (value) => value > 0 });
    const issues = schema.safeParse(-4321).issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe('must be greater than zero');
    expect(issues[0]?.message).not.toContain('4321');
  });

  test('the predicate never runs when the shape already failed', () => {
    let ran = false;
    const schema = makeNumberSchema().refine({
      ...positive,
      check: () => {
        ran = true;
        return true;
      },
    });
    expect(schema.safeParse('nope').issues).toBeDefined();
    expect(ran).toBe(false);
  });

  test('a passing predicate returns the parsed value untouched', () => {
    const schema = makeNumberSchema().refine({ ...positive, check: (value) => value > 0 });
    expect(schema.safeParse(7)).toEqual({ value: 7 });
  });

  test('the rule is declared on the node so a projection can read it without the closure', () => {
    const schema = makeNumberSchema().refine({
      ...positive,
      path: ['amount'],
      check: (value) => value > 0,
    });
    expect(schema.node.refinements).toEqual([
      { name: 'positive', message: 'must be greater than zero', path: ['amount'] },
    ]);
    // The original is untouched — every builder method returns a new schema.
    expect(makeNumberSchema().node.refinements).toBeUndefined();
  });

  test('`path` moves the issue onto the field the rule is about', () => {
    const schema = makeNumberSchema().refine({
      ...positive,
      path: ['amount'],
      check: (value) => value > 0,
    });
    expect(schema.safeParse(-1).issues?.[0]?.path).toEqual(['amount']);
  });

  test('refinements stack in declaration order and both reach the node', () => {
    const schema = makeNumberSchema()
      .refine({ ...positive, check: (value) => value > 0 })
      .refine({ name: 'even', message: 'must be even', check: (value) => value % 2 === 0 });
    expect(schema.node.refinements?.map((rule) => rule.name)).toEqual(['positive', 'even']);
    expect(schema.safeParse(3).issues?.[0]?.message).toBe('must be even');
    expect(schema.safeParse(4).issues).toBeUndefined();
  });

  test('optional/nullable/default/describe all carry the refinement through', () => {
    const schema = makeNumberSchema().refine({ ...positive, check: (value) => value > 0 });
    expect(schema.optional().node.refinements).toHaveLength(1);
    expect(schema.nullable().safeParse(null)).toEqual({ value: null });
    expect(schema.optional().safeParse(-1).issues).toBeDefined();
    expect(schema.describe('a count').safeParse(-1).issues).toBeDefined();
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
