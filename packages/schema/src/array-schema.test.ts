// `t.array(items, { min, max })` — item-count bounds on the array node itself (issue #687), pinned
// at the public `validate()` boundary and at both projections that publish the node: the OpenAPI /
// JSON Schema document and the MCP tool's wire schema. A bound the parser enforces and a document
// omits is a 422 every generated client walks into.

import { describe, expect, test } from 'bun:test';
import { arraySchema } from './array-schema';
import { isSchemaError } from './errors';
import { toJsonSchema } from './json-schema';
import { validate } from './standard';
import { t } from './t';
import { builtinT } from './validators';
import { toWireSchema } from './wire-schema';

const ids = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );

const page = t.array(t.uuid, { min: 1, max: 3 });

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

describe('t.array item-count bounds', () => {
  test('omitting the bounds behaves as before: empty and long arrays both pass', () => {
    const open = t.array(t.uuid);
    expect(validate(open, []).issues).toBeUndefined();
    expect(validate(open, ids(50)).issues).toBeUndefined();
    expect(open.node.minItems).toBeUndefined();
    expect(open.node.maxItems).toBeUndefined();
  });

  test('a count inside the bounds passes, edges included', () => {
    for (const count of [1, 2, 3]) {
      const result = validate(page, ids(count));
      expect(result.issues).toBeUndefined();
      if (result.issues === undefined) expect(result.value).toEqual(ids(count));
    }
  });

  test('below `min` is refused at the array, with the normal issue shape', () => {
    const result = validate(page, []);
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]?.path).toEqual([]);
    expect(result.issues?.[0]?.message).toBe(
      'expected an array of at least 1 item, received an empty array',
    );
  });

  test('above `max` is refused at the array, before any item is read', () => {
    const result = validate(page, [...ids(3), 'not-a-uuid']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]?.message).toBe(
      'expected an array of at most 3 items, received an array of 4 items',
    );
  });

  test('the bound sits on the field path inside an object', () => {
    const result = validate(t.object({ postIds: page }), { postIds: [] });
    expect(result.issues?.[0]?.path).toEqual(['postIds']);
  });

  test('either bound alone is honoured', () => {
    expect(validate(t.array(t.number, { min: 2 }), [1]).issues).toHaveLength(1);
    expect(validate(t.array(t.number, { min: 2 }), [1, 2, 3, 4]).issues).toBeUndefined();
    expect(validate(t.array(t.number, { max: 1 }), [1, 2]).issues).toHaveLength(1);
    expect(validate(t.array(t.number, { max: 1 }), []).issues).toBeUndefined();
  });
});

describe('t.array bounds are refused where they are WRITTEN when no array could satisfy them', () => {
  const codeOf = (declare: () => unknown): string => {
    try {
      declare();
    } catch (error) {
      if (isSchemaError(error)) return error.code;
      return expect.unreachable('not a SchemaError');
    }
    return expect.unreachable('the declaration was accepted');
  };

  test.each([
    ['min above max', { min: 3, max: 2 }],
    ['a negative min', { min: -1 }],
    ['a fractional max', { max: 1.5 }],
    ['a non-finite max', { max: Number.POSITIVE_INFINITY }],
  ])('%s is X_SCHEMA_BOUNDS_INVALID', (_label, bounds) => {
    expect(codeOf(() => t.array(t.number, bounds))).toBe('X_SCHEMA_BOUNDS_INVALID');
  });

  test('min equal to max is a fixed length, and legal', () => {
    expect(validate(t.array(t.number, { min: 2, max: 2 }), [1, 2]).issues).toBeUndefined();
  });
});

describe('t.array bounds reach every projection', () => {
  test('JSON Schema / OpenAPI carry minItems and maxItems', () => {
    expect(toJsonSchema(page)).toMatchObject({ type: 'array', minItems: 1, maxItems: 3 });
    expect(toJsonSchema(t.array(t.uuid))).not.toHaveProperty('minItems');
  });

  test('the MCP wire schema carries them too', () => {
    const wire = toWireSchema(t.object({ postIds: page }));
    expect(wire.properties?.['postIds']).toMatchObject({ minItems: 1, maxItems: 3 });
  });

  test('a nullable bounded array keeps its bounds inside the non-null branch', () => {
    expect(toJsonSchema(t.nullable(page))).toMatchObject({
      anyOf: [{ type: 'array', minItems: 1, maxItems: 3 }, { type: 'null' }],
    });
  });
});
