// unit — the read half of `openapi.json`. Deterministic bytes are the whole contract: `x verify`
// diffs the file, so the same registry twice is the same string, and the page controls the route
// reads are written into every operation from the one module that spells them.

import { describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { queryOpenApiPaths, toQueryOpenApiOperation } from './openapi';
import { MAX_PAGE_SIZE, PAGE_AFTER_KEY, PAGE_FIRST_KEY } from './page-controls';
import { query } from './query';
import { from } from './source';

interface Row {
  readonly id: string;
}

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
    expect(ok.oneOf[1]?.['required']).toEqual(['rows', 'endCursor', 'hasNextPage']);
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
