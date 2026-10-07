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
import { isMcpExposed, RECORDS_OPENAPI_HEADER, recordEnvelopeSchema } from '@ultimat3/core';
import type { SchemaNode } from '@ultimat3/schema';
import { nodeToJsonSchema, tryIntrospect } from '@ultimat3/schema';
import { derivePath } from './naming';
import { MAX_PAGE_SIZE, PAGE_AFTER_KEY, PAGE_FIRST_KEY } from './page-controls';
import { policyCapability } from './policy-gate';
import type { AnyQuery } from './query';
import { queryName } from './read';
import { answersRecords } from './record-answer';
import { listQueries } from './registry';

/**
 * `@ultimat3/action`'s `PROBLEM_SCHEMA_NAME`, restated: the CLI merges this file's paths into that
 * package's document, which is what puts the component the `$ref` names into `components`.
 */
const PROBLEM_SCHEMA_REF = '#/components/schemas/Problem';

/** One tag for every read: an action is tagged by its resource, a read by what it is. */
const QUERY_TAG = 'query';

export type OpenApiPathItem = Record<string, unknown>;

/**
 * Two shapes, decided by the request: the bare rows every client read before the controls
 * existed, and the page envelope when `_first` is sent. `oneOf` and not a second operation — it is
 * one route, one policy evaluation, one URL prefix.
 */
const ANSWERS: readonly Record<string, unknown>[] = [
  { type: 'array', items: {} },
  {
    type: 'object',
    // The one page shape: the `endCursor`/`hasNextPage` alias pair left in 25.0.0 (O-12).
    required: ['rows', 'nextCursor', 'hasMore'],
    properties: {
      rows: { type: 'array', items: {} },
      nextCursor: {
        type: ['string', 'null'],
        description: `the signed cursor for the next page — send it as ${PAGE_AFTER_KEY}; null exactly when hasMore is false`,
      },
      hasMore: { type: 'boolean', description: 'whether another page follows' },
    },
    // `@ultimat3/core`'s `Page` is a union, and so is its wire shape: the two facts cannot
    // disagree in a body this document validates (25.0.0 — the last page used to keep a cursor).
    oneOf: [
      { properties: { nextCursor: { type: 'string' }, hasMore: { const: true } } },
      { properties: { nextCursor: { type: 'null' }, hasMore: { const: false } } },
    ],
  },
];

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
  if (target.single === true) return singleOperation(target, name);
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
            // A read declaring an entity's `rows:` ALWAYS answers the envelope, with the same two
            // shapes under `data` — core's one description, shared with the action projection.
            schema: answersRecords(target.rows)
              ? recordEnvelopeSchema({ oneOf: ANSWERS })
              : { oneOf: ANSWERS },
          },
        },
        ...(answersRecords(target.rows) ? { headers: RECORDS_OPENAPI_HEADER } : {}),
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
      // Core's one predicate, the one `@ultimat3/mcp`'s catalog and the action side ask: a tool is
      // advertised only where the MCP catalog lists one, under the export name verbatim.
      tool: isMcpExposed(target.mcp) ? name : null,
    },
  };
}

/**
 * A `single: true` read: one object, a 404 when there is none, and no page controls — the route
 * refuses them, so advertising them would document a guaranteed 400. Everything else — the input
 * parameters, the record envelope, the `x-ultimate` block — is the list operation's, unchanged.
 */
function singleOperation(target: AnyQuery, name: string): Record<string, unknown> {
  const records = answersRecords(target.rows);
  return {
    operationId: name,
    tags: [QUERY_TAG],
    summary: target.mcp?.description ?? name,
    ...(target.deprecated === undefined ? {} : { deprecated: true }),
    parameters: inputParameters(target.input),
    responses: {
      '200': {
        description: 'ok',
        content: {
          'application/json': {
            schema: records ? recordEnvelopeSchema(SINGLE_ANSWER) : SINGLE_ANSWER,
          },
        },
        ...(records ? { headers: RECORDS_OPENAPI_HEADER } : {}),
      },
      '400': problemResponse('X_INPUT_INVALID'),
      '403': problemResponse('policy denied'),
      '404': problemResponse('X_NOT_FOUND — the read matched no row for this input'),
    },
    'x-ultimate': {
      capability: policyCapability(target.policy),
      live: target.isLive,
      single: true,
      cacheTags: tagKeys(target.cache?.tags ?? []),
      tool: isMcpExposed(target.mcp) ? name : null,
    },
  };
}

/** One row. Its members are not published — a query declares no output schema, as `ANSWERS` says. */
const SINGLE_ANSWER: Readonly<Record<string, unknown>> = { type: 'object' };

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
    description: `the nextCursor a previous page answered; needs ${PAGE_FIRST_KEY}`,
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
