import { describe, expect, test } from 'bun:test';
import {
  describeValue,
  discriminatedUnionSchema,
  expected,
  nullableSchema,
  optionalSchema,
  refineSchema,
  t,
} from './index';

describe('@ultimat3/schema public surface', () => {
  test('the composers ship as free functions as well as namespace members', () => {
    // Same rule as `nullableSchema`: a call site holding a schema should not have to reach for
    // the namespace, and a namespace member with no free function is half an export.
    expect(typeof refineSchema).toBe('function');
    expect(typeof discriminatedUnionSchema).toBe('function');
    expect(typeof t.refine).toBe('function');
    expect(typeof t.discriminatedUnion).toBe('function');
  });

  test('the value renderer is exported and shape-only at the package boundary too', () => {
    expect(describeValue('hunter2')).toBe('a string of 7 characters');
    expect(expected('a uuid', 'hunter2')).not.toContain('hunter2');
  });

  test('exports `nullableSchema` alongside `optionalSchema`', () => {
    // `t.nullable` and `t.optional` are twins in the namespace; the free functions the
    // generators reach for must stay twins in the export list too.
    expect(typeof nullableSchema).toBe('function');
    expect(typeof optionalSchema).toBe('function');
  });

  test('`nullableSchema` admits null and still validates the inner schema', () => {
    const coverUrl = nullableSchema(t.url);
    expect(coverUrl.parse(null)).toBeNull();
    expect(coverUrl.parse('https://ultimate.dev')).toBe('https://ultimate.dev');
    expect(() => coverUrl.parse('nope')).toThrow(/X_VALIDATION_FAILED/);
    // Null is a value the column holds; omission is `optionalSchema`, not this.
    expect(() => coverUrl.parse(undefined)).toThrow(/X_VALIDATION_FAILED/);
  });
});
