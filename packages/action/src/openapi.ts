/**
 * Projection 2: the whole registry as one OpenAPI 3.1 document.
 *
 * DETERMINISM IS A HARD REQUIREMENT. `x verify` diffs this output against the
 * committed spec to detect contract drift, so: keys are sorted at every depth
 * (`stableStringify`), paths and components are built from the name-sorted
 * registry, and nothing here reads the clock, the environment or a random source.
 */

import { ERROR_RETRY_KINDS, templateParams, toOpenApiPath } from '@ultimat3/core';
import type { AnyAction } from './action';
import { operationTagOf, toOpenApiOperation } from './http';
import { methodOfHttp, servedActionRoute } from './http-path';
import { actionName, defOf } from './invoke';
import { type JsonSchemaObject, jsonSchemaOf, sortSchema } from './json-schema';
import { inputSchemaName, outputSchemaName, PROBLEM_SCHEMA_NAME } from './naming';
import { listActions } from './registry';
import { stableStringify } from './stable';

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: OpenApiInfo;
  /** Only in the complete document (`defineApi({ openapi: { servers } })`). */
  readonly servers?: readonly { readonly url: string; readonly description?: string }[];
  readonly paths: Record<string, unknown>;
  readonly components: {
    readonly schemas: Record<string, JsonSchemaObject>;
    /** Only in the complete document — `completeOpenApi` / `mountOpenApi`. */
    readonly securitySchemes?: Readonly<Record<string, unknown>>;
  };
  readonly tags: readonly { readonly name: string }[];
}

export interface BuildOpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  /** Defaults to the whole registry. Pass a subset to spec one surface only. */
  readonly actions?: readonly AnyAction[];
}

export function buildOpenApi(options: BuildOpenApiOptions = {}): OpenApiDocument {
  const actions = [...(options.actions ?? listActions())].sort(compareByName);
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, JsonSchemaObject> = { [PROBLEM_SCHEMA_NAME]: PROBLEM_SCHEMA };
  const tags = new Set<string>();

  for (const target of actions) {
    const name = actionName(target);
    const { path } = servedActionRoute(name);
    const documented = toOpenApiPath(path);
    // Merged, never replaced: REST's two verbs on one URL are two operations of one path item.
    const item = Object.hasOwn(paths, documented) ? (paths[documented] as object) : {};
    const verb = methodOfHttp(defOf(target).http).toLowerCase();
    paths[documented] = { ...item, [verb]: toOpenApiOperation(target) };
    // The component IS the request body, so a `:param`'s key leaves it: the URL carries it.
    schemas[inputSchemaName(name)] = withoutKeys(
      sortSchema(jsonSchemaOf(target.input)),
      templateParams(path),
    );
    schemas[outputSchemaName(name)] = sortSchema(jsonSchemaOf(target.output));
    tags.add(operationTagOf(target));
  }

  return {
    openapi: '3.1.0',
    info: { title: options.title ?? 'Ultimate API', version: options.version ?? '0.0.0' },
    paths,
    components: { schemas },
    tags: [...tags].sort().map((name) => ({ name })),
  };
}

/** The bytes `x verify` compares. Sorted keys, trailing newline, 2-space indent. */
export function serializeOpenApi(document: OpenApiDocument): string {
  return `${stableStringify(document, 2)}\n`;
}

/** `schema` minus `keys` from `properties` and `required`; the same object when `keys` is empty. */
function withoutKeys(schema: JsonSchemaObject, keys: readonly string[]): JsonSchemaObject {
  if (keys.length === 0) return schema;
  const properties = schema['properties'];
  const required = schema['required'];
  const kept =
    typeof properties === 'object' && properties !== null
      ? Object.fromEntries(Object.entries(properties).filter(([key]) => !keys.includes(key)))
      : properties;
  const { required: _dropped, ...rest } = schema;
  const still = Array.isArray(required)
    ? required.filter((key: unknown) => typeof key !== 'string' || !keys.includes(key))
    : [];
  return {
    ...rest,
    ...(kept === undefined ? {} : { properties: kept }),
    // Omitted when nothing is left, as `jsonSchemaOf` omits it for an all-optional object.
    ...(still.length === 0 ? {} : { required: still }),
  };
}

function compareByName(a: AnyAction, b: AnyAction): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * RFC 9457 + the Ultimate error contract, member for member what `@ultimat3/http`'s `toProblem`
 * serves (`openapi-problem.test.ts` compares the two). `code` carries no `pattern`: `factsOf`
 * serves whatever string an app's own throwable holds, and a published pattern the server breaks
 * makes a generated client reject the very document it was written to read.
 */
const PROBLEM_SCHEMA: JsonSchemaObject = {
  type: 'object',
  required: ['type', 'title', 'status', 'code'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    cause: { type: 'string' },
    fix: { type: 'string' },
    docs: { type: 'string', format: 'uri' },
    // The class a client maps to an exception. On every document, hidden 5xx included.
    retry: { type: 'string', enum: [...ERROR_RETRY_KINDS] },
    requestId: { type: 'string' },
    // Absent when the failure produced none — never `[]`, which would claim "validated clean".
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'expected', 'received', 'message'],
        properties: {
          path: { type: 'string' },
          expected: { type: 'string' },
          received: { type: 'string' },
          message: { type: 'string' },
          // `SCHEMA_RULES` is the vocabulary; typed `string` because it grows (add, never rename).
          rule: { type: 'string' },
          params: { type: 'object' },
        },
      },
    },
    // Only the keys the code declared through `registerProblemMeta`; its shape is per code.
    meta: { type: 'object' },
  },
};
