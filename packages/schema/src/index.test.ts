import { describe, expect, test } from 'bun:test';
import { nullableSchema, optionalSchema, t } from './index';

describe('@ultimat3/schema public surface', () => {
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
