/**
 * Standard Schema -> JSON Schema, normalized to a plain record. OpenAPI, MCP
 * descriptors and the manifest all need the same object, produced the same way.
 */

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { toJsonSchema, toMcpInputSchema } from '@ultimat3/schema';
import { isJsonObject, stableStringify } from './stable';

export type JsonSchemaObject = Record<string, unknown>;

/**
 * Never throws: a schema that cannot be converted degrades to a permissive
 * object node, because a missing OpenAPI detail must not break a deploy.
 */
export function jsonSchemaOf(schema: StandardSchemaV1): JsonSchemaObject {
  return normalize(() => toJsonSchema(schema));
}

/** Draft-07, no `$schema` — the exact shape an MCP `tools/list` entry needs. */
export function mcpSchemaOf(schema: StandardSchemaV1): JsonSchemaObject {
  return normalize(() => toMcpInputSchema(schema));
}

function normalize(convert: () => unknown): JsonSchemaObject {
  try {
    const raw: unknown = convert();
    if (isJsonObject(raw)) return raw;
  } catch {
    // fall through to the permissive node
  }
  return { type: 'object', additionalProperties: true };
}

/** Key-sorted copy — deterministic ordering for the committed contract file. */
export function sortSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const parsed: unknown = JSON.parse(stableStringify(schema));
  return isJsonObject(parsed) ? parsed : {};
}
