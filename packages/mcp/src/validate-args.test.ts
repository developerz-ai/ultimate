// Argument validation against a tool's declared JSON Schema — the ONE arg contract an agent
// sees via tools/list. Every branch of `walk` gets its own case: object/array/string/number/
// boolean/null, enum, const, anyOf, defaults, and unknown-property rejection.

import { describe, expect, test } from 'bun:test';
import { validateArgs } from './validate-args';
import type { JsonSchema } from './wire';

describe('validateArgs: object', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      role: { type: 'string', default: 'reader' },
    },
    required: ['name'],
    additionalProperties: false,
  };

  test('valid input passes through with declared defaults applied', () => {
    expect(validateArgs(schema, { name: 'ada' })).toEqual({
      ok: true,
      value: { name: 'ada', role: 'reader' },
    });
  });

  test('an explicit value overrides the default', () => {
    expect(validateArgs(schema, { name: 'ada', role: 'admin' })).toEqual({
      ok: true,
      value: { name: 'ada', role: 'admin' },
    });
  });

  test('a missing required property is reported at its own path', () => {
    const result = validateArgs(schema, {});
    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'name', message: 'is required' }],
    });
  });

  test('an explicit undefined counts as absent, not present', () => {
    const result = validateArgs(schema, { name: undefined });
    expect(result.ok).toBe(false);
  });

  test('additionalProperties false rejects an unknown key', () => {
    const result = validateArgs(schema, { name: 'ada', extra: 1 });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'extra', message: 'unknown property' }],
    });
  });

  test('additionalProperties omitted (not false) passes an unknown key through untouched', () => {
    const open: JsonSchema = { type: 'object', properties: { id: { type: 'string' } } };
    expect(validateArgs(open, { id: 'x', extra: 'y' })).toEqual({
      ok: true,
      value: { id: 'x', extra: 'y' },
    });
  });

  test('a non-object top-level input is rejected at the root path', () => {
    expect(validateArgs(schema, 'nope')).toEqual({
      ok: false,
      issues: [{ path: '', message: 'must be an object' }],
    });
    expect(validateArgs(schema, ['array'])).toEqual({
      ok: false,
      issues: [{ path: '', message: 'must be an object' }],
    });
  });

  test('raw undefined/null is treated as an empty object', () => {
    const optional: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
    expect(validateArgs(optional, undefined)).toEqual({ ok: true, value: {} });
    expect(validateArgs(optional, null)).toEqual({ ok: true, value: {} });
  });

  test('nested object paths are dotted', () => {
    const nested: JsonSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { email: { type: 'string' } },
          required: ['email'],
        },
      },
    };
    expect(validateArgs(nested, { user: {} })).toEqual({
      ok: false,
      issues: [{ path: 'user.email', message: 'is required' }],
    });
  });
});

describe('validateArgs: array', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' } } },
  };

  test('every item is validated at an indexed path', () => {
    const result = validateArgs(schema, { tags: ['a', 2] });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'tags[1]', message: 'must be a string' }],
    });
  });

  test('a non-array value is rejected', () => {
    expect(validateArgs(schema, { tags: 'not-array' })).toEqual({
      ok: false,
      issues: [{ path: 'tags', message: 'must be an array' }],
    });
  });

  test('items schema omitted passes each element through untouched', () => {
    const loose: JsonSchema = { type: 'object', properties: { any: { type: 'array' } } };
    expect(validateArgs(loose, { any: [1, 'two', true] })).toEqual({
      ok: true,
      value: { any: [1, 'two', true] },
    });
  });
});

describe('validateArgs: string', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { code: { type: 'string', minLength: 2, maxLength: 4 } },
  };

  test('length within bounds passes', () => {
    expect(validateArgs(schema, { code: 'abc' })).toEqual({ ok: true, value: { code: 'abc' } });
  });

  test('too short and too long are both reported', () => {
    expect(validateArgs(schema, { code: 'a' })).toEqual({
      ok: false,
      issues: [{ path: 'code', message: 'must be at least 2 characters' }],
    });
    expect(validateArgs(schema, { code: 'abcde' })).toEqual({
      ok: false,
      issues: [{ path: 'code', message: 'must be at most 4 characters' }],
    });
  });

  test('a non-string is reported and bound checks are skipped', () => {
    expect(validateArgs(schema, { code: 5 })).toEqual({
      ok: false,
      issues: [{ path: 'code', message: 'must be a string' }],
    });
  });
});

describe('validateArgs: number / integer', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { count: { type: 'integer', minimum: 1, maximum: 10 } },
  };

  test('a valid integer within range passes', () => {
    expect(validateArgs(schema, { count: 5 })).toEqual({ ok: true, value: { count: 5 } });
  });

  test('below minimum and above maximum are both reported', () => {
    expect(validateArgs(schema, { count: 0 })).toEqual({
      ok: false,
      issues: [{ path: 'count', message: 'must be >= 1' }],
    });
    expect(validateArgs(schema, { count: 11 })).toEqual({
      ok: false,
      issues: [{ path: 'count', message: 'must be <= 10' }],
    });
  });

  test('a fractional value fails the integer check in addition to any range checks', () => {
    const result = validateArgs(schema, { count: 5.5 });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'count', message: 'must be an integer' }],
    });
  });

  test('NaN is rejected as not-a-number, never passed through', () => {
    expect(validateArgs(schema, { count: Number.NaN })).toEqual({
      ok: false,
      issues: [{ path: 'count', message: 'must be a number' }],
    });
  });

  test('a plain number type has no integer constraint', () => {
    const loose: JsonSchema = { type: 'object', properties: { ratio: { type: 'number' } } };
    expect(validateArgs(loose, { ratio: 1.5 })).toEqual({ ok: true, value: { ratio: 1.5 } });
  });
});

describe('validateArgs: boolean / null', () => {
  test('boolean accepts true/false, rejects other types', () => {
    const schema: JsonSchema = { type: 'object', properties: { on: { type: 'boolean' } } };
    expect(validateArgs(schema, { on: true })).toEqual({ ok: true, value: { on: true } });
    expect(validateArgs(schema, { on: 'yes' })).toEqual({
      ok: false,
      issues: [{ path: 'on', message: 'must be a boolean' }],
    });
  });

  test('null type accepts only null', () => {
    const schema: JsonSchema = { type: 'object', properties: { gone: { type: 'null' } } };
    expect(validateArgs(schema, { gone: null })).toEqual({ ok: true, value: { gone: null } });
    expect(validateArgs(schema, { gone: 'x' })).toEqual({
      ok: false,
      issues: [{ path: 'gone', message: 'must be null' }],
    });
  });
});

describe('validateArgs: const / enum', () => {
  test('const requires an exact match', () => {
    const schema: JsonSchema = { type: 'object', properties: { kind: { const: 'post' } } };
    expect(validateArgs(schema, { kind: 'post' })).toEqual({ ok: true, value: { kind: 'post' } });
    expect(validateArgs(schema, { kind: 'comment' })).toEqual({
      ok: false,
      issues: [{ path: 'kind', message: 'must equal "post"' }],
    });
  });

  test('enum requires membership and names the allowed set', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { status: { type: 'string', enum: ['draft', 'published'] } },
    };
    expect(validateArgs(schema, { status: 'draft' })).toEqual({
      ok: true,
      value: { status: 'draft' },
    });
    expect(validateArgs(schema, { status: 'archived' })).toEqual({
      ok: false,
      issues: [{ path: 'status', message: 'must be one of draft | published' }],
    });
  });
});

describe('validateArgs: anyOf', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      id: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    },
  };

  test('the first branch that validates wins', () => {
    expect(validateArgs(schema, { id: 'uuid-1' })).toEqual({ ok: true, value: { id: 'uuid-1' } });
    expect(validateArgs(schema, { id: 42 })).toEqual({ ok: true, value: { id: 42 } });
  });

  test('no matching branch reports the union, not each branch individually', () => {
    expect(validateArgs(schema, { id: true })).toEqual({
      ok: false,
      issues: [{ path: 'id', message: 'does not match any of the 2 allowed shapes' }],
    });
  });
});

describe('validateArgs: default schema type', () => {
  test('a schema with no recognised type passes the value through untouched', () => {
    const schema: JsonSchema = { type: 'object', properties: { anything: {} } };
    expect(validateArgs(schema, { anything: { nested: true } })).toEqual({
      ok: true,
      value: { anything: { nested: true } },
    });
  });
});

// A `tools/call` names its arguments, and an agent — or whatever is driving one — chooses those
// names. `Object.prototype` supplies a value for `constructor`, `toString` and `__proto__` on
// every plain object, so a membership test that reads the prototype chain answers "declared" for
// three names no schema declared: the arguments were accepted and then dropped, which is the one
// outcome nothing downstream can detect. Third instance of the class in this sweep, after
// `@ultimat3/i18n`'s catalog lookup and `@ultimat3/schema`'s `coerce`.
describe('validateArgs: a property named after one of Object.prototype', () => {
  const strict: JsonSchema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  };

  test('additionalProperties false refuses it, exactly as it refuses any other unknown key', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(validateArgs(strict, { id: 'a', [key]: 1 })).toEqual({
        ok: false,
        issues: [{ path: key, message: 'unknown property' }],
      });
    }
  });

  test('an open schema carries it through as an OWN key, never dropped', () => {
    const open: JsonSchema = { type: 'object', properties: { id: { type: 'string' } } };
    const result = validateArgs(open, { id: 'a', constructor: 1, toString: 2 });
    expect(result.ok).toBe(true);
    const value = result.ok ? result.value : {};
    expect(Object.hasOwn(value, 'constructor')).toBe(true);
    expect(value['constructor']).toBe(1);
    expect(value['toString']).toBe(2);
  });

  // The half the `hasOwn` fix would otherwise turn from a drop into a pollution: `out[key] = v`
  // for `__proto__` runs the setter on `Object.prototype` and REPLACES the result's prototype
  // instead of adding a key, so the arguments a handler reads carry properties nobody sent.
  test('an open schema cannot have the result object re-prototyped by a __proto__ argument', () => {
    const open: JsonSchema = { type: 'object', properties: { id: { type: 'string' } } };
    const result = validateArgs(open, JSON.parse('{"id":"a","__proto__":{"isAdmin":true}}'));
    expect(result.ok).toBe(true);
    const value = result.ok ? result.value : {};
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value['isAdmin']).toBeUndefined();
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
  });

  // A schema that really does declare one of those names is the reason the discriminator is
  // `Object.hasOwn` rather than a deny-list: declared is declared, and it still validates.
  test('a schema that declares such a property validates it like any other', () => {
    // The inner schema is annotated rather than inlined: `constructor` resolves to
    // `Object.prototype.constructor` before the index signature of `properties`, so the literal
    // never receives `JsonSchema` as its contextual type and `'string'` widens to `string`.
    const stringProperty: JsonSchema = { type: 'string' };
    const declared: JsonSchema = {
      type: 'object',
      properties: { constructor: stringProperty },
      required: ['constructor'],
      additionalProperties: false,
    };
    expect(validateArgs(declared, { constructor: 'ctor' })).toEqual({
      ok: true,
      value: { constructor: 'ctor' },
    });
    expect(validateArgs(declared, { constructor: 7 })).toEqual({
      ok: false,
      issues: [{ path: 'constructor', message: 'must be a string' }],
    });
  });
});
