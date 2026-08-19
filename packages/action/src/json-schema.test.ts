/**
 * `jsonSchemaOf`/`mcpSchemaOf` REFUSE a schema the active provider cannot describe — publishing
 * "any object accepted" for an input `validateInput` rejects every payload from is the deploy that
 * succeeds while every caller is lied to — and `sortSchema` is the byte-stable ordering the
 * committed OpenAPI file depends on.
 */

import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { jsonSchemaOf, mcpSchemaOf, normalizeJsonSchema, sortSchema } from './json-schema';

const Schema = t.object({ postId: t.uuid, title: t.string });

/** Structurally a schema, but carries no `node` — `nodeOf` cannot introspect it. */
const unintrospectable = {
  '~standard': { version: 1, vendor: 'test', validate: () => ({ value: undefined }) },
} as unknown as StandardSchemaV1;

describe('jsonSchemaOf', () => {
  test('converts a real schema to a plain JSON-schema-shaped object', () => {
    const result = jsonSchemaOf(Schema);

    expect(result.type).toBe('object');
    expect(result.properties).toMatchObject({
      postId: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
    });
    expect(result.required).toEqual(['postId', 'title']);
  });

  // `additionalProperties: true` was published for a schema the runtime rejects EVERYTHING from,
  // so the OpenAPI component and the MCP `inputSchema` both said "any object accepted" while
  // `validateInput` refused every payload. A spec that cannot be produced must not be produced.
  test('refuses, with the provider code, when the provider cannot introspect it', () => {
    expect(() => jsonSchemaOf(unintrospectable)).toThrow(/X_SCHEMA_UNSUPPORTED/);
  });
});

describe('mcpSchemaOf', () => {
  test('converts a real schema, draft-07, without a $schema key', () => {
    const result = mcpSchemaOf(Schema);

    expect(result.$schema).toBeUndefined();
    expect(result.type).toBe('object');
  });

  test('refuses, with the provider code, when the provider cannot introspect it', () => {
    expect(() => mcpSchemaOf(unintrospectable)).toThrow(/X_SCHEMA_UNSUPPORTED/);
  });
});

describe('sortSchema', () => {
  test('produces a deterministic, key-sorted copy regardless of build order', () => {
    const forward = { type: 'object', properties: { a: {}, b: {} }, additionalProperties: false };
    const backward = { additionalProperties: false, properties: { b: {}, a: {} }, type: 'object' };

    expect(JSON.stringify(sortSchema(forward))).toBe(JSON.stringify(sortSchema(backward)));
  });

  test('sorts keys at every depth', () => {
    const schema = { type: 'object', properties: { title: {}, postId: {} } };

    const sorted = sortSchema(schema);

    expect(Object.keys(sorted)).toEqual(['properties', 'type']);
    expect(Object.keys(sorted.properties as Record<string, unknown>)).toEqual(['postId', 'title']);
  });

  test('drops undefined-valued keys, matching stableStringify', () => {
    const schema = { type: 'object', description: undefined };

    const sorted = sortSchema(schema);

    expect('description' in sorted).toBe(false);
  });
});

/**
 * A fix line is PASTED, so one naming an API that does not exist is worse than none — axiom 4.
 * `x verify`'s `errors` step checks a `fix:` for SHAPE and never for whether the member it names
 * is real, which is how "configure a provider whose toJsonSchema returns an object" shipped:
 * `SchemaProvider` has no such member and `toJsonSchema()` calls `introspect()` unconditionally.
 */
describe('the refusal a non-object conversion earns', () => {
  /** The error itself, so its `fix:` can be read rather than matched against a message. */
  const refusalFrom = (convert: () => unknown): Record<string, unknown> => {
    try {
      normalizeJsonSchema(convert);
      return {};
    } catch (error) {
      return error as unknown as Record<string, unknown>;
    }
  };

  test('keeps the shipped code and names the value it got', () => {
    const refusal = refusalFrom(() => 42);

    expect(refusal['code']).toBe('X_SCHEMA_UNSUPPORTED');
    expect(refusal['cause']).toContain('number');
  });

  test('the fix names introspect(), and no toJsonSchema member', () => {
    const fix = refusalFrom(() => null)['fix'];

    expect(fix).toContain('introspect');
    // The member that does not exist. `provider.ts` is the file that decides this, and the two
    // must agree: `introspect()` returning a `SchemaNode` is the whole of the provider seam.
    expect(fix).not.toContain('toJsonSchema');
  });

  test('an array is refused too — a JSON Schema object is never a list', () => {
    expect(refusalFrom(() => [])['code']).toBe('X_SCHEMA_UNSUPPORTED');
  });
});
