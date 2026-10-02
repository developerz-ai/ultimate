/**
 * Projection 2: the whole registry as one OpenAPI 3.1 document.
 *
 * DETERMINISM IS A HARD REQUIREMENT. `x verify` diffs this output against the
 * committed spec to detect contract drift, so: keys are sorted at every depth
 * (`stableStringify`), paths and components are built from the name-sorted
 * registry, and nothing here reads the clock, the environment or a random source.
 */

import type { AnyAction } from './action';
import { operationTagOf, toOpenApiOperation } from './http';
import { servedActionRoute } from './http-path';
import { actionName } from './invoke';
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
    paths[path] = { post: toOpenApiOperation(target) };
    schemas[inputSchemaName(name)] = sortSchema(jsonSchemaOf(target.input));
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
        },
      },
    },
    // Only the keys the code declared through `registerProblemMeta`; its shape is per code.
    meta: { type: 'object' },
  },
};
