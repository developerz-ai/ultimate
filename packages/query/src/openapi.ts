/**
 * Projection: a query's route as an OpenAPI 3.1 path item, so `openapi.json` — the file `x verify`
 * diffs and the typed client is generated from — documents the READ half of the API. It documented
 * only the write half until 2026-09: `buildOpenApi` in `@ultimat3/action` walks the action
 * registry, and every `GET /_x/query/<name>` was served by `api-routes.ts` and published nowhere,
 * which is why the page controls this route now reads had no document to be written into.
 *
 * Ported beside `@ultimat3/action`'s rather than composed with it: both packages are tier 3 and
 * tiers never go sideways, so the CLI — the one caller that writes the file — merges the two
 * `paths` maps (`packages/cli/src/app-openapi.ts`). The component names this file references are
 * restated, and pinned in `openapi.test.ts` against what the action side emits.
 *
 * DETERMINISM IS A HARD REQUIREMENT, as it is one package over: `serializeOpenApi` sorts keys at
 * every depth, so only the ARRAYS here need an order — parameters by name, then the two page
 * controls — and nothing reads the clock, the environment or a random source.
 */

import { tagKeys } from '@ultimat3/cache';
import type { SchemaNode } from '@ultimat3/schema';
import { nodeToJsonSchema, tryIntrospect } from '@ultimat3/schema';
import { isExposed } from './mcp-tool';
import { derivePath } from './naming';
import { MAX_PAGE_SIZE, PAGE_AFTER_KEY, PAGE_FIRST_KEY } from './page-controls';
import { policyCapability } from './policy-gate';
import type { AnyQuery } from './query';
import { queryName } from './read';
import { listQueries } from './registry';

/**
 * `@ultimat3/action`'s `PROBLEM_SCHEMA_NAME`, restated: the CLI merges this file's paths into that
 * package's document, which is what puts the component the `$ref` names into `components`.
 */
const PROBLEM_SCHEMA_REF = '#/components/schemas/Problem';

/** One tag for every read: an action is tagged by its resource, a read by what it is. */
const QUERY_TAG = 'query';

export type OpenApiPathItem = Record<string, unknown>;

/** `{ [path]: { get: operation } }` for every registered read, name-sorted like the actions. */
export function queryOpenApiPaths(
  queries: readonly AnyQuery[] = listQueries(),
): Record<string, OpenApiPathItem> {
  const paths: Record<string, OpenApiPathItem> = {};
  for (const target of [...queries].sort(compareByName)) {
    paths[derivePath(queryName(target))] = { get: toQueryOpenApiOperation(target) };
  }
  return paths;
}

/**
 * The GET operation for one read. The input's members are `in: query` parameters — a read is
 * served from its search string (`input-shape.ts` is what guarantees every member fits one) — and
 * the two page controls follow them, on every read, because every read pages through the same
 * route code. `required` follows the schema: optional or defaulted is not required.
 */
export function toQueryOpenApiOperation(target: AnyQuery): Record<string, unknown> {
  const name = queryName(target);
  return {
    operationId: name,
    tags: [QUERY_TAG],
    summary: target.mcp?.description ?? name,
    ...(target.deprecated === undefined ? {} : { deprecated: true }),
    parameters: [...inputParameters(target.input), ...PAGE_PARAMETERS],
    responses: {
      '200': {
        description: 'ok',
        content: {
          'application/json': {
            // Two shapes, decided by the request: the bare rows every client read before the
            // controls existed, and the page envelope when `_first` is sent. `oneOf` and not a
            // second operation — it is one route, one policy evaluation, one URL prefix.
            schema: {
              oneOf: [
                { type: 'array', items: {} },
                {
                  type: 'object',
                  required: ['rows', 'endCursor', 'hasNextPage'],
                  properties: {
                    rows: { type: 'array', items: {} },
                    endCursor: { type: ['string', 'null'] },
                    hasNextPage: { type: 'boolean' },
                  },
                },
              ],
            },
          },
        },
      },
      // `X_INPUT_INVALID` is the search string failing the read's own schema, or a page control
      // outside its bound; `X_CURSOR_INVALID` is an `_after` that is not one of this read's. Both
      // are the caller's to repair, which is what 400 says.
      '400': problemResponse('X_INPUT_INVALID or X_CURSOR_INVALID'),
      '403': problemResponse('policy denied'),
    },
    'x-ultimate': {
      capability: policyCapability(target.policy),
      live: target.isLive,
      cacheTags: tagKeys(target.cache?.tags ?? []),
      // The same rule `toMcpTool` and the action side apply: a tool is advertised only where the
      // MCP catalog lists one, under the export name verbatim (`mcp-tool.ts`).
      tool: isExposed(target) ? name : null,
    },
  };
}

/** The two controls, spelled from `page-controls.ts` so the document cannot drift from the route. */
const PAGE_PARAMETERS: readonly Record<string, unknown>[] = [
  {
    name: PAGE_FIRST_KEY,
    in: 'query',
    required: false,
    description: `page size; present, the response is the page envelope rather than the bare rows (1 to ${MAX_PAGE_SIZE})`,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
  },
  {
    name: PAGE_AFTER_KEY,
    in: 'query',
    required: false,
    description: `the endCursor a previous page answered; needs ${PAGE_FIRST_KEY}`,
    schema: { type: 'string' },
  },
];

/**
 * A member per declared property, name-sorted. A schema this package cannot introspect — a
 * foreign Standard Schema, the seam `configureSchemaProvider` exists for — publishes no
 * parameters rather than guessed ones, the same answer `assertEncodableInput` gives it.
 */
function inputParameters(input: unknown): readonly Record<string, unknown>[] {
  const node = tryIntrospect(input);
  if (node?.properties === undefined) return [];
  return Object.entries(node.properties)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => parameterOf(key, child));
}

function parameterOf(name: string, node: SchemaNode): Record<string, unknown> {
  return {
    name,
    in: 'query',
    required: node.optional !== true && node.hasDefault !== true,
    schema: nodeToJsonSchema(node),
  };
}

function problemResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { 'application/problem+json': { schema: { $ref: PROBLEM_SCHEMA_REF } } },
  };
}

function compareByName(a: AnyQuery, b: AnyQuery): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
