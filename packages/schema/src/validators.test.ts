// Single responsibility: pins the schema COMBINATORS' accept/reject contract at the public
// `validate()` boundary — the same seam actions, jobs and MCP tools trust. WHY there and not
// against the checks directly: a loosened rule has to fail here, as a red test, rather than
// downstream as a mass-assigned field, a float Money row or an unparseable date.
//
// The builtin scalars live in `validators-builtins.test.ts`; together the two were over the
// 500-line ceiling.

import { describe, expect, test } from 'bun:test';
import { formatIssues, validate } from './standard';
import {
  arraySchema,
  builtinT,
  enumSchema,
  literalSchema,
  nullableSchema,
  objectSchema,
  optionalSchema,
  recordSchema,
  refineSchema,
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

  test('reads a declared field as an OWN property, never off `Object.prototype`', () => {
    // `value['toString']` found the INHERITED function for an input that never carried the key, so
    // an optional field named after a prototype member was unsatisfiable for every input — and
    // `coerceNode`, which already guards with `Object.hasOwn`, disagreed about the same payload.
    const schema = objectSchema({
      toString: optionalSchema(builtinT.string),
      title: builtinT.string,
    });
    const result = validate(schema, { title: 'hi' });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      // Not `toEqual({ title: 'hi' })`: an object literal's apparent `toString` is
      // `Object.prototype`'s `() => string`, which TS compares against the declared
      // `toString?: string` and rejects. Own keys say the same thing and say it more exactly —
      // the bug was `toString` landing as an INHERITED read, which `Object.keys` cannot see.
      expect(Object.keys(result.value)).toEqual(['title']);
      expect(result.value.title).toBe('hi');
    }
  });

  test('a prototype-named field falls back to its `.default()` when the caller omits it', () => {
    const schema = objectSchema({ valueOf: builtinT.string.default('fallback') });
    const result = validate(schema, {});
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) expect(result.value).toEqual({ valueOf: 'fallback' });
  });

  test('a declared `__proto__` field lands as an own key, not through the prototype setter', () => {
    // On a `{}` literal `out['__proto__'] = value` hits the SETTER: the parse answered `{}` whose
    // prototype was the caller's object, so a handler reading any key of it got attacker data.
    const schema = objectSchema({ ['__proto__']: recordSchema(builtinT.string) });
    const result = validate(schema, JSON.parse('{"__proto__":{"a":"b"}}'));
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      const value: unknown = result.value;
      expect(Object.getPrototypeOf(value)).toBe(null);
      expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({ a: 'b' });
    }
  });

  /**
   * The published IR, not the parse output beside it: `properties[key] = member.node` on a `{}`
   * literal hits the prototype SETTER for `__proto__`, so the field was absent from
   * `node.properties` — the map `json-schema.ts` publishes and `coerce.ts` walks. Validation still
   * ran it (the `checks` array is a list of pairs), so a field was enforced on the wire, missing
   * from the OpenAPI document and never coerced from a query string, with nothing red anywhere.
   */
  test('a declared `__proto__` field is an own key of the published IR', () => {
    const schema = objectSchema({ ['__proto__']: builtinT.string });
    const properties = schema.node.properties ?? {};
    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect(Object.keys(properties)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(properties)).toBe(null);
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
      'expected one of draft | published, received a string of 8 characters',
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

  // Rewritten, because the assertion it replaces PINNED the defect: it read
  // `path).toEqual(['b'])` and called a caller-chosen key a "key path". A record's keys are the
  // caller's data — `describe-value.ts`'s absolute, applied to the other half of an issue — and
  // `@ultimat3/http`'s `bodyInvalid` states the contract this broke in its own doc block:
  // *"`issues` … must name only facts the framework itself chose … Anything the caller sent goes
  // in `meta`"*. The path travelled `formatIssue` -> `bodyInvalid`'s `cause` -> the problem
  // document AND the log line, where the logger redacts by KEY and a key baked into a string has
  // no key left to redact.
  test('names each failing entry by POSITION, never by the caller-chosen key', () => {
    const schema = recordSchema(builtinT.number);
    const result = validate(schema, { a: 1, b: 'bad', c: 3, d: 'also bad' });
    expect(result.issues?.length).toBe(2);
    expect(result.issues?.[0]?.path).toEqual([1]);
    expect(result.issues?.[1]?.path).toEqual([3]);
  });

  test('a key that is a secret reaches neither the path nor the message', () => {
    const schema = objectSchema({ meta: recordSchema(builtinT.string) });
    const rendered = formatIssues(
      validate(schema, { meta: { 'hunter2-was-my-password': 5 } }).issues ?? [],
    );
    expect(rendered).toEqual(['meta[0]: expected a non-empty string, received a number']);
    expect(rendered.join('')).not.toContain('hunter2');
  });

  test('a `__proto__` key cannot reach the prototype of the output object', () => {
    // Before: `out.a` read "pwned" while `Object.keys(out)` was empty, so every
    // `input.settings[k] ?? fallback` in a handler answered with the attacker's value.
    const schema = recordSchema(objectSchema({ a: builtinT.string }));
    const result = validate(schema, JSON.parse('{"__proto__":{"a":"pwned"}}'));
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0]?.path).toEqual([0]);
    // The refused NAME is a closed set this file declares, so the message may state it — that is
    // the one string here the caller did not choose.
    expect(result.issues?.[0]?.message).toContain('__proto__');
  });

  test('`constructor` and `prototype` are refused for the same reason', () => {
    const schema = recordSchema(builtinT.number);
    expect(validate(schema, { constructor: 1 }).issues?.[0]?.path).toEqual([0]);
    expect(validate(schema, { prototype: 1 }).issues?.[0]?.path).toEqual([0]);
  });

  test('the accepted record carries no prototype at all', () => {
    const schema = recordSchema(builtinT.number);
    const result = validate(schema, { a: 1 });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(Object.getPrototypeOf(result.value)).toBe(null);
      expect(result.value).toEqual({ a: 1 });
    }
  });
});

describe('refineSchema', () => {
  test('refuses a value the shape accepts but the rule does not', () => {
    const lines = refineSchema(
      objectSchema({ total: builtinT.number.int(), paid: builtinT.number.int() }),
      {
        name: 'paid-within-total',
        message: 'paid must not exceed total',
        path: ['paid'],
        check: (value) => value.paid <= value.total,
      },
    );
    expect(validate(lines, { total: 100, paid: 40 }).issues).toBeUndefined();
    const issues = validate(lines, { total: 100, paid: 4000 }).issues ?? [];
    expect(issues[0]?.message).toBe('paid must not exceed total');
    expect(issues[0]?.path).toEqual(['paid']);
    // The rule states itself; it never states the amount that broke it.
    expect(issues[0]?.message).not.toContain('4000');
  });

  test('is the free-function spelling of the method, node included', () => {
    const rule = { name: 'even', message: 'must be even', check: (v: number) => v % 2 === 0 };
    expect(refineSchema(builtinT.number, rule).node.refinements).toEqual(
      builtinT.number.refine(rule).node.refinements,
    );
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
