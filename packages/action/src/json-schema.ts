/**
 * Standard Schema -> JSON Schema, normalized to a plain record. OpenAPI, MCP
 * descriptors and the manifest all need the same object, produced the same way.
 */

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { SchemaUnsupportedError, toJsonSchema, toMcpInputSchema } from '@ultimat3/schema';
import { isJsonObject, stableStringify } from './stable';

export type JsonSchemaObject = Record<string, unknown>;

/**
 * REFUSES rather than degrades. This used to swallow a conversion failure into
 * `{ type: 'object', additionalProperties: true }` so that "a missing OpenAPI detail must not
 * break a deploy" — which inverts axiom 3: the deploy succeeded and every caller was lied to.
 * `toJsonSchema` throws exactly when the spec must not claim anything, and the same schema
 * still fails `validateInput` on every payload, so the OpenAPI component and the MCP
 * `inputSchema` were advertising "any object accepted" for an endpoint that accepts none.
 * `registerAction` calls this at boot (`assertProjectable`), so a registered action can never
 * reach a projection that throws.
 */
export function jsonSchemaOf(schema: StandardSchemaV1): JsonSchemaObject {
  return normalize(() => toJsonSchema(schema));
}

/** Draft-07, no `$schema` — the exact shape an MCP `tools/list` entry needs. */
export function mcpSchemaOf(schema: StandardSchemaV1): JsonSchemaObject {
  return normalize(() => toMcpInputSchema(schema));
}

function normalize(convert: () => unknown): JsonSchemaObject {
  const raw: unknown = convert();
  if (isJsonObject(raw)) return raw;
  // A converter that answered with something that is not a JSON object is the same failure by a
  // quieter route, so it gets the same shipped code rather than a permissive node.
  throw new SchemaUnsupportedError({
    cause: `the schema converted to ${raw === null ? 'null' : typeof raw}, not a JSON Schema object`,
    fix: 'declare the schema with `t` from @ultimat3/action, or configure a provider whose toJsonSchema returns an object: configureSchemaProvider({ ... })',
  });
}

/** Key-sorted copy — deterministic ordering for the committed contract file. */
export function sortSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const parsed: unknown = JSON.parse(stableStringify(schema));
  return isJsonObject(parsed) ? parsed : {};
}
