import { describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import * as barrel from './index';
import { describeValue, expected, t } from './index';
import { nullableSchema } from './validators';

describe('@ultimat3/schema public surface', () => {
  test('the composers ship once, as `t` members, never as free functions on `.`', () => {
    // v31 (D10): one way to compose — `t.refine`, `t.nullable`, … A free twin on the barrel was
    // a second path an agent had to choose between.
    const surface: Record<string, unknown> = barrel;
    for (const name of [
      'arraySchema',
      'discriminatedUnionSchema',
      'enumSchema',
      'nullableSchema',
      'optionalSchema',
      'refineSchema',
      'unionSchema',
      'builtinT',
    ]) {
      expect(surface[name]).toBeUndefined();
    }
    expect(typeof t.refine).toBe('function');
    expect(typeof t.discriminatedUnion).toBe('function');
    expect(typeof t.nullable).toBe('function');
    expect(typeof t.optional).toBe('function');
  });

  test('the provider accessors live on `./adapter`, not on `.`', () => {
    const surface: Record<string, unknown> = barrel;
    for (const name of ['builtinProvider', 'resetSchemaProvider', 'schemaProvider']) {
      expect(surface[name]).toBeUndefined();
    }
    expect(typeof adapter.schemaProvider).toBe('function');
    expect(typeof adapter.resetSchemaProvider).toBe('function');
    expect(adapter.builtinProvider.vendor).toBe('ultimate');
    expect(typeof barrel.configureSchemaProvider).toBe('function');
  });

  test('the value renderer is exported and shape-only at the package boundary too', () => {
    expect(describeValue('hunter2')).toBe('a string of 7 characters');
    expect(expected('a uuid', 'hunter2')).not.toContain('hunter2');
  });

  test('`nullableSchema` admits null and still validates the inner schema', () => {
    const coverUrl = nullableSchema(t.url);
    expect(coverUrl.parse(null)).toBeNull();
    expect(coverUrl.parse('https://app.test/cover.png')).toBe('https://app.test/cover.png');
    expect(() => coverUrl.parse('nope')).toThrow(/X_VALIDATION_FAILED/);
    // Null is a value the column holds; omission is `optionalSchema`, not this.
    expect(() => coverUrl.parse(undefined)).toThrow(/X_VALIDATION_FAILED/);
  });
});
