import { afterEach, describe, expect, test } from 'bun:test';
import { toJsonSchema, toMcpInputSchema } from './json-schema';
import { configureSchemaProvider, resetSchemaProvider } from './provider';
import { t } from './t';
import { builtinT } from './validators';

afterEach(() => {
  resetSchemaProvider();
});

const publishPost = t.object({
  postId: t.uuid,
  notify: t.boolean.default(true),
  price: t.money,
  tags: t.array(t.slug),
  status: t.enum(['draft', 'published']),
  publishAt: t.optional(t.date),
});

describe('toJsonSchema', () => {
  test('emits the exact shape OpenAPI and MCP consume', () => {
    const schema = toJsonSchema(publishPost, { includeDialect: false });

    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    // Defaults and optionals are not required; everything else is.
    expect(schema.required).toEqual(['postId', 'price', 'tags', 'status']);
    expect(schema.properties?.['postId']).toEqual({ type: 'string', format: 'uuid' });
    expect(schema.properties?.['notify']).toEqual({ type: 'boolean', default: true });
    expect(schema.properties?.['tags']).toEqual({
      type: 'array',
      items: { type: 'string', format: 'slug', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
    });
    expect(schema.properties?.['status']).toEqual({
      type: 'string',
      enum: ['draft', 'published'],
    });
    expect(schema.properties?.['publishAt']).toEqual({ type: 'string', format: 'date-time' });
  });

  test('money projects to integer minor units plus an ISO code', () => {
    const money = toJsonSchema(t.money, { includeDialect: false });
    expect(money).toMatchObject({
      type: 'object',
      required: ['minor', 'currency'],
      additionalProperties: false,
      properties: {
        minor: { type: 'integer' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      },
    });
  });

  test('money admits an optional scale without requiring one', () => {
    const money = toJsonSchema(t.money, { includeDialect: false });
    // `additionalProperties: false` is what made a scaled value fail a generated client's own
    // check while the framework's validator accepted it.
    expect(money.properties?.['scale']).toMatchObject({ type: 'integer', minimum: 0 });
    expect(money.required).toEqual(['minor', 'currency']);
  });

  test('dialects: 2020-12 by default, draft-07 for MCP tools', () => {
    expect(toJsonSchema(t.object({ id: t.uuid })).$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(toJsonSchema(t.object({ id: t.uuid }), { dialect: 'draft-07' }).$schema).toBe(
      'http://json-schema.org/draft-07/schema#',
    );
    expect(toMcpInputSchema(t.object({ id: t.uuid }))).toEqual({
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  test('a provider that cannot introspect fails loudly with a fix line', () => {
    configureSchemaProvider({ vendor: 'zod', t: builtinT });
    expect(() => toJsonSchema({ notASchema: true })).toThrow(/X_SCHEMA_UNSUPPORTED/);
    try {
      toJsonSchema({ notASchema: true });
    } catch (thrown) {
      expect((thrown as { fix: string }).fix).toContain('configureSchemaProvider');
    }
  });

  test('a swapped provider actually backs t', () => {
    let calls = 0;
    configureSchemaProvider({
      vendor: 'custom',
      t: {
        ...builtinT,
        get uuid() {
          calls += 1;
          return builtinT.uuid;
        },
      },
      introspect: () => undefined,
    });
    void t.uuid;
    expect(calls).toBe(1);
  });
});
