import { afterEach, describe, expect, test } from 'bun:test';
import { nodeToJsonSchema, toJsonSchema, toMcpInputSchema } from './json-schema';
import { CURRENCY_CODE_PATTERN } from './money-value';
import type { SchemaNode } from './node';
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
    // Both halves on purpose: the literal above pins WHAT is published (a shipped contract), this
    // pins that it is the same string the validator tests against and not a fourth copy of it.
    expect(money.properties?.['currency']?.pattern).toBe(CURRENCY_CODE_PATTERN);
  });

  test('money admits an optional scale without requiring one', () => {
    const money = toJsonSchema(t.money, { includeDialect: false });
    // `additionalProperties: false` is what made a scaled value fail a generated client's own
    // check while the framework's validator accepted it.
    expect(money.properties?.['scale']).toMatchObject({ type: 'integer', minimum: 0 });
    expect(money.required).toEqual(['minor', 'currency']);
  });

  // `t.money`'s `minor` has published the safe-integer range since the validator started demanding
  // one; `t.number.int()` published `{ type: 'integer' }` and nothing else, so the contract a
  // generated client, an MCP tool schema and `openapi.json` all read promised a range the parser
  // refuses — the same disagreement one layer out.
  test('an integer publishes the safe range its validator enforces', () => {
    expect(toJsonSchema(t.number.int(), { includeDialect: false })).toEqual({
      type: 'integer',
      minimum: -Number.MAX_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  test("a caller's own bounds are the published ones, and a wider one is clamped to the safe range", () => {
    expect(toJsonSchema(t.number.int().min(1).max(50), { includeDialect: false })).toMatchObject({
      minimum: 1,
      maximum: 50,
    });
    // `2 ** 53` is refused by the validator whatever `.max()` says, so publishing it would be the
    // promise this test exists to delete.
    expect(
      toJsonSchema(
        t.number
          .int()
          .min(-(2 ** 60))
          .max(2 ** 60),
        { includeDialect: false },
      ),
    ).toMatchObject({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
  });

  test('a non-integer number publishes no bounds it does not have', () => {
    // `t.number` accepts every finite double; a safe-integer range here would refuse `0.5`.
    expect(toJsonSchema(t.number, { includeDialect: false })).toEqual({ type: 'number' });
    expect(toJsonSchema(t.number.min(0.5), { includeDialect: false })).toEqual({
      type: 'number',
      minimum: 0.5,
    });
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

  test('a refinement reaches the projection twice: as prose and as an extension', () => {
    // The axiom-2 break this closes: the rule used to live in the handler, so `openapi.json`,
    // the MCP tool schema and the typed client all described a schema that accepts what the
    // server rejects. Both halves ship — the extension for code generators, the description for
    // an LLM reading a tool schema, which is the only field it is guaranteed to be shown.
    const range = t
      .object({ startDate: t.date, endDate: t.date })
      .refine({
        name: 'end-after-start',
        message: 'endDate must be after startDate',
        path: ['endDate'],
        check: (value) => value.endDate > value.startDate,
      })
      .describe('a closed date range');
    const json = toJsonSchema(range, { includeDialect: false });
    expect(json.description).toBe('a closed date range — endDate must be after startDate');
    expect(json['x-ultimate-refinements']).toEqual([
      { name: 'end-after-start', message: 'endDate must be after startDate', path: ['endDate'] },
    ]);
  });

  test('a nullable field projects the null branch its own validator accepts', () => {
    // The round trip that was missing: the IR field and its projection pinned together. `nullable`
    // was declared, set by `.nullable()` and read by exactly one consumer, so every published
    // spec forbade a `null` the action's own `output:` validator returns — a generated client
    // typed it non-null and a spec-validating gateway rejected the server's own valid response.
    const post = t.object({ title: t.string, coverUrl: t.nullable(t.url) });
    const coverNode = post.node.properties?.['coverUrl'];
    expect(coverNode?.nullable).toBe(true);

    const json = toJsonSchema(post, { includeDialect: false });
    expect(json.properties?.['coverUrl']).toEqual({
      anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }],
    });
    // nullable is not optional: the key is still sent, it just carries `null`.
    expect(json.required).toEqual(['title', 'coverUrl']);
    expect(post.parse({ title: 'a', coverUrl: null })).toEqual({ title: 'a', coverUrl: null });
  });

  test('a nullable field carries its annotations outside the anyOf', () => {
    const json = toJsonSchema(
      t.object({ note: t.nullable(t.string.describe('why it was skipped')) }),
      { includeDialect: false },
    );
    expect(json.properties?.['note']).toEqual({
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
      description: 'why it was skipped',
    });
  });

  test('a nullable field with a default stays out of required and keeps the default', () => {
    const json = toJsonSchema(t.object({ cover: t.nullable(t.url).default(null) }), {
      includeDialect: false,
    });
    expect(json.required).toEqual([]);
    expect(json.properties?.['cover']).toEqual({
      anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }],
      default: null,
    });
  });

  test('an unrefined schema gains no new keys — nothing already generated moves', () => {
    const json = toJsonSchema(t.object({ id: t.uuid }), { includeDialect: false });
    expect('x-ultimate-refinements' in json).toBe(false);
    expect('discriminator' in json).toBe(false);
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

  test('a provider supplying toJsonSchema is not an alternative to introspect', () => {
    configureSchemaProvider({
      vendor: 'phantom',
      t: builtinT,
      // @ts-expect-error — `SchemaProvider` has no `toJsonSchema` member. The doc clause that
      // said `introspect` could be omitted "if the provider also supplies toJsonSchema"
      // described an API that never existed: this path throws on every OpenAPI and MCP
      // projection. If the member is ever really added, this line stops erroring and fails.
      toJsonSchema: () => ({ type: 'object' }),
    });

    expect(() => toJsonSchema({ notASchema: true })).toThrow(/X_SCHEMA_UNSUPPORTED/);
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

/**
 * The same prototype-chain read `@ultimat3/action`'s `sample-input.ts` carries, one package down.
 * `node.format` arrives from a schema PROVIDER's IR — `configureSchemaProvider` is the seam, so
 * the string is not this build's — and `FORMAT_MAP['constructor']` is the `Object` function
 * rather than `undefined`, which the `?? node.format` fallback cannot rescue. A function in
 * `format` is dropped silently by `JSON.stringify`, so the published `openapi.json` lost the
 * constraint with nothing anywhere saying it had.
 */
describe('a foreign format is looked up in the table, never on Object.prototype', () => {
  const stringNode = (format: string): SchemaNode =>
    ({ kind: 'string', format }) as unknown as SchemaNode;

  test.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'invented-by-a-provider'])(
    'format %s is published verbatim, as a string',
    (format) => {
      const schema = nodeToJsonSchema(stringNode(format));
      expect(schema['format']).toBe(format);
      expect(typeof schema['format']).toBe('string');
    },
  );

  test('a format this build does map is still translated', () => {
    expect(nodeToJsonSchema(stringNode('timezone'))['format']).toBe('iana-time-zone');
    expect(nodeToJsonSchema(stringNode('cursor'))['format']).toBe('ultimate-cursor');
  });
});
