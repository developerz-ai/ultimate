// unit — the read half of `openapi.json`. Deterministic bytes are the whole contract: `x verify`
// diffs the file, so the same registry twice is the same string, and the page controls the route
// reads are written into every operation from the one module that spells them.

import { describe, expect, test } from 'bun:test';
import { entity, MAX_PAGE_SIZE, text, uuid } from '@ultimat3/entity';
import { can } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { queryOpenApiPaths, toQueryOpenApiOperation } from './openapi';
import { PAGE_AFTER_KEY, PAGE_FIRST_KEY } from './page-controls';
import type { AnyQuery } from './query';
import { query } from './query';
import { from } from './source';

interface Row {
  readonly id: string;
}

// An entity's branded row schema, the `rows: Post.$schema` an app writes.
const oaPosts = entity('oa_posts', { columns: { id: uuid().primaryKey(), title: text() } });

const feed = query({
  input: t.object({
    orgId: t.uuid,
    limit: t.number.int().min(1).max(50).default(20),
    tag: t.string.optional(),
  }),
  policy: can('feed:read'),
  cache: { tags: [{ entity: 'posts' }] },
  mcp: { expose: true, description: 'The org feed' },
  sql: () => from<Row>('posts', []).orderBy('id'),
}).named('orgFeed');

const slugs = query({
  input: t.object({}),
  policy: can('post:read'),
  sql: () => from<Row>('posts', []).orderBy('id'),
}).named('postSlugs');

type Operation = {
  parameters: readonly { name: string; required: boolean; schema: Record<string, unknown> }[];
  responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
  'x-ultimate': Record<string, unknown>;
  summary: string;
  operationId: string;
};

describe('the read half of openapi.json', () => {
  test('every declared member is an `in: query` parameter, name-sorted, required as declared', () => {
    const operation = toQueryOpenApiOperation(feed) as Operation;
    expect(operation.parameters.map((p) => p.name)).toEqual([
      'limit',
      'orgId',
      'tag',
      PAGE_FIRST_KEY,
      PAGE_AFTER_KEY,
    ]);
    expect(operation.parameters.map((p) => p.required)).toEqual([false, true, false, false, false]);
  });

  test('the two page controls are on every read, with the bound the route checks', () => {
    const operation = toQueryOpenApiOperation(slugs) as Operation;
    const first = operation.parameters.find((p) => p.name === PAGE_FIRST_KEY);
    expect(first?.schema).toEqual({ type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE });
    expect(operation.parameters.find((p) => p.name === PAGE_AFTER_KEY)?.schema).toEqual({
      type: 'string',
    });
  });

  test('200 is the bare rows OR the page envelope, and both refusals point at Problem', () => {
    const operation = toQueryOpenApiOperation(feed) as Operation;
    const ok = operation.responses['200']?.content['application/json']?.schema as {
      oneOf: readonly Record<string, unknown>[];
    };
    expect(ok.oneOf).toHaveLength(2);
    expect(ok.oneOf[1]?.['required']).toEqual(['rows', 'nextCursor', 'hasMore']);
    const properties = ok.oneOf[1]?.['properties'] as Record<string, { description?: string }>;
    expect(Object.keys(properties).sort()).toEqual(['hasMore', 'nextCursor', 'rows']);
    expect(properties['nextCursor']?.description).toBeString();
    // The one page shape's one meaning, on the wire (25.0.0): a cursor exactly when another page
    // follows. A generated client or a validator reads it here, not from prose.
    expect(ok.oneOf[1]?.['oneOf']).toEqual([
      { properties: { nextCursor: { type: 'string' }, hasMore: { const: true } } },
      { properties: { nextCursor: { type: 'null' }, hasMore: { const: false } } },
    ]);
    expect(properties['nextCursor']?.description).toContain('null exactly when hasMore is false');
    expect(operation.responses['400']?.content['application/problem+json']?.schema).toEqual({
      $ref: '#/components/schemas/Problem',
    });
  });

  test('the extension carries the capability, the tags and the tool name the catalog lists', () => {
    expect((toQueryOpenApiOperation(feed) as Operation)['x-ultimate']).toEqual({
      capability: 'feed:read',
      live: false,
      cacheTags: ['posts'],
      tool: 'orgFeed',
    });
    expect((toQueryOpenApiOperation(slugs) as Operation)['x-ultimate']['tool']).toBeNull();
    expect((toQueryOpenApiOperation(feed) as Operation).summary).toBe('The org feed');
    expect((toQueryOpenApiOperation(slugs) as Operation).summary).toBe('postSlugs');
  });

  test('paths are keyed by the URL the client derives, and declaration order changes no byte', () => {
    const forward = serializeOpenApi(fakeDocument(queryOpenApiPaths([feed, slugs])));
    const backward = serializeOpenApi(fakeDocument(queryOpenApiPaths([slugs, feed])));
    expect(forward).toBe(backward);
    expect(Object.keys(queryOpenApiPaths([slugs, feed]))).toEqual([
      '/_x/query/org-feed',
      '/_x/query/post-slugs',
    ]);
  });
});

/**
 * The operation's `200` schema as a plain object. The literals in this describe are today's bytes,
 * spelled out: a projection that drifts for a read with no `rows:` stales every committed document.
 */
const okSchema = (target: AnyQuery): Record<string, unknown> =>
  (toQueryOpenApiOperation(target) as Operation).responses['200']?.content['application/json']
    ?.schema as Record<string, unknown>;

/** The shape `page.rows`, `oneOf[0]` and `data` must all carry for the row below. */
const ROW_WIRE = {
  type: 'object',
  required: ['id', 'title'],
  properties: { id: { type: 'string' }, title: { type: 'string' } },
};

const Declared = t.object({ id: t.string, title: t.string });

const declared = (rows: unknown, single = false): AnyQuery =>
  query({
    input: t.object({}),
    policy: can('post:read'),
    ...(rows === undefined ? {} : { rows: rows as StandardSchemaV1<unknown, Row> }),
    ...(single ? { single: true as const } : {}),
    sql: () => from<Row>('posts', []).orderBy('id'),
  }).named('declaredRead');

describe('a declared `rows:` is what the read publishes', () => {
  test('a list: the row in the bare array and in the page envelope', () => {
    const schema = okSchema(declared(Declared)) as {
      oneOf: readonly { type?: string; items?: unknown; properties?: { rows?: unknown } }[];
    };
    expect(schema.oneOf[0]).toEqual({ type: 'array', items: ROW_WIRE });
    expect(schema.oneOf[1]?.properties?.rows).toEqual({ type: 'array', items: ROW_WIRE });
  });

  test('a single read: the row, in place of a bare object', () => {
    expect(okSchema(declared(Declared, true))).toEqual(ROW_WIRE);
  });

  test("an entity's `rows:`: the record envelope wraps either answer, members inside `data`", () => {
    const list = okSchema(declared(oaPosts.$schema)) as {
      properties: {
        data: { oneOf: readonly { items?: { properties?: Record<string, unknown> } }[] };
      };
    };
    expect(Object.keys(list.properties.data.oneOf[0]?.items?.properties ?? {}).sort()).toEqual([
      'id',
      'title',
    ]);
    const single = okSchema(declared(oaPosts.$schema, true)) as {
      properties: { data: { properties?: Record<string, unknown> } };
    };
    expect(Object.keys(single.properties.data.properties ?? {}).sort()).toEqual(['id', 'title']);
  });

  test('a list and a single keep the page contract beside the row', () => {
    const schema = okSchema(declared(Declared)) as {
      oneOf: readonly Record<string, unknown>[];
    };
    expect(schema.oneOf[1]?.['required']).toEqual(['rows', 'nextCursor', 'hasMore']);
    expect(schema.oneOf[1]?.['oneOf']).toHaveLength(2);
  });

  // The file a client generates from must not gain a component: the CLI merges only `paths`.
  test('the row is inline, never a component this package could not publish', () => {
    expect(JSON.stringify(okSchema(declared(Declared)))).not.toContain('$ref');
  });
});

describe('a read with nothing to publish keeps the bytes it had', () => {
  const UNTYPED_LIST = {
    oneOf: [
      { type: 'array', items: {} },
      {
        type: 'object',
        required: ['rows', 'nextCursor', 'hasMore'],
        properties: {
          rows: { type: 'array', items: {} },
          nextCursor: {
            type: ['string', 'null'],
            description: `the signed cursor for the next page — send it as ${PAGE_AFTER_KEY}; null exactly when hasMore is false`,
          },
          hasMore: { type: 'boolean', description: 'whether another page follows' },
        },
        oneOf: [
          { properties: { nextCursor: { type: 'string' }, hasMore: { const: true } } },
          { properties: { nextCursor: { type: 'null' }, hasMore: { const: false } } },
        ],
      },
    ],
  };

  test('no `rows:`: a list and a single', () => {
    expect(okSchema(declared(undefined))).toEqual(UNTYPED_LIST);
    expect(okSchema(declared(undefined, true))).toEqual({ type: 'object' });
  });

  test('a `rows:` that cannot be introspected: the same, never a guess', () => {
    const foreign = {
      '~standard': { version: 1, vendor: 'foreign', validate: (value: unknown) => ({ value }) },
    };
    expect(okSchema(declared(foreign))).toEqual(UNTYPED_LIST);
    expect(okSchema(declared(foreign, true))).toEqual({ type: 'object' });
  });

  test('a `rows:` whose root is not an object: the same — a row is an object', () => {
    expect(okSchema(declared(t.string))).toEqual(UNTYPED_LIST);
  });
});

describe('a download query', () => {
  const recording = query({
    input: t.object({ runId: t.uuid }),
    policy: can('recording:read'),
    download: {
      handle: async () => ({ body: new Uint8Array(), contentType: 'video/mp4', filename: 'a' }),
    },
  }).named('runRecording');

  test('publishes the input and _token, the mint and the file, and no page control', () => {
    const operation = toQueryOpenApiOperation(recording) as Operation;
    expect(operation.parameters.map((p) => p.name)).toEqual(['runId', '_token']);
    // The file is whatever `handle` answers — `video/mp4`, `text/csv` — so its media type is `*/*`.
    expect(Object.keys(operation.responses['200']?.content ?? {}).sort()).toEqual([
      '*/*',
      'application/json',
    ]);
    expect(operation.responses['200']?.content['*/*']?.schema).toEqual({
      type: 'string',
      format: 'binary',
    });
    expect(operation.responses['206']?.content['*/*']?.schema).toEqual({
      type: 'string',
      format: 'binary',
    });
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200',
      '206',
      '400',
      '401',
      '403',
      '410',
      '416',
    ]);
    expect(operation['x-ultimate']).toMatchObject({ download: true, live: false, tool: null });
  });
});

/**
 * Key-sorted JSON, so two documents that differ only in declaration order serialise to the same
 * bytes — what `@ultimat3/action`'s `serializeOpenApi` does for the merged document. Spelled here
 * rather than imported: action is tier 3 like this package, and a sideways import is a boundary
 * violation even from a test.
 */
const serializeOpenApi = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : entry,
  );

/** Enough of an `OpenApiDocument` to sort — the shape is action's. */
const fakeDocument = (paths: Record<string, unknown>) => ({
  openapi: '3.1.0' as const,
  info: { title: 't', version: '0' },
  paths,
  components: { schemas: {} },
  tags: [],
});
