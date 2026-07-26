/**
 * Projection 2: the whole registry as one OpenAPI 3.1 document.
 *
 * DETERMINISM IS A HARD REQUIREMENT. `x verify` diffs this output against the
 * committed spec to detect contract drift, so: keys are sorted at every depth
 * (`stableStringify`), paths and components are built from the name-sorted
 * registry, and nothing here reads the clock, the environment or a random source.
 */

import type { AnyAction } from './action';
import { actionName } from './action';
import { toOpenApiOperation } from './http';
import { type JsonSchemaObject, jsonSchemaOf, sortSchema } from './json-schema';
import { derivePath, inputSchemaName, outputSchemaName, PROBLEM_SCHEMA_NAME } from './naming';
import { listActions } from './registry';
import { stableStringify } from './stable';

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: OpenApiInfo;
  readonly paths: Record<string, unknown>;
  readonly components: { readonly schemas: Record<string, JsonSchemaObject> };
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
    const { path, resource } = derivePath(name);
    paths[path] = { post: toOpenApiOperation(target) };
    schemas[inputSchemaName(name)] = sortSchema(jsonSchemaOf(target.def.input));
    schemas[outputSchemaName(name)] = sortSchema(jsonSchemaOf(target.def.output));
    tags.add(resource);
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

/** RFC 9457 + the Ultimate error contract (code / cause / fix / docs). */
const PROBLEM_SCHEMA: JsonSchemaObject = {
  type: 'object',
  required: ['type', 'title', 'status', 'code'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    code: { type: 'string', pattern: '^X_[A-Z0-9_]+$' },
    cause: { type: 'string' },
    fix: { type: 'string' },
    docs: { type: 'string', format: 'uri' },
  },
};
