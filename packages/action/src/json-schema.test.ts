/**
 * `jsonSchemaOf`/`mcpSchemaOf` never throw — a schema the active provider cannot
 * describe degrades to a permissive node rather than breaking a deploy — and
 * `sortSchema` is the byte-stable ordering the committed OpenAPI file depends on.
 */

import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { jsonSchemaOf, mcpSchemaOf, sortSchema } from './json-schema';

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

  test('degrades to the permissive fallback node when the provider cannot introspect it', () => {
    const result = jsonSchemaOf(unintrospectable);

    expect(result).toEqual({ type: 'object', additionalProperties: true });
  });
});

describe('mcpSchemaOf', () => {
  test('converts a real schema, draft-07, without a $schema key', () => {
    const result = mcpSchemaOf(Schema);

    expect(result.$schema).toBeUndefined();
    expect(result.type).toBe('object');
  });

  test('degrades to the permissive fallback node when the provider cannot introspect it', () => {
    const result = mcpSchemaOf(unintrospectable);

    expect(result).toEqual({ type: 'object', additionalProperties: true });
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
