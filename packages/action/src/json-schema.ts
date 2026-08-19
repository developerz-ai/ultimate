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
  return normalizeJsonSchema(() => toJsonSchema(schema));
}

/** Draft-07, no `$schema` — the exact shape an MCP `tools/list` entry needs. */
export function mcpSchemaOf(schema: StandardSchemaV1): JsonSchemaObject {
  return normalizeJsonSchema(() => toMcpInputSchema(schema));
}

/**
 * The narrowing both projections share, and the refusal it earns: a converter that answered with
 * something that is not a JSON object is the same failure by a quieter route, so it gets the same
 * shipped code rather than a permissive node. Exported for its own test and nothing else — it is
 * absent from `src/index.ts`, exactly as `sortSchema` is.
 *
 * **The `fix:` names `introspect`, never a `toJsonSchema` member.** `SchemaProvider` declares no
 * such member (`packages/schema/src/provider.ts`) and `toJsonSchema()` calls `introspect()`
 * unconditionally, so the old line — "configure a provider whose toJsonSchema returns an object" —
 * instructed a reader to implement an API that does not exist, which is axiom 4 inverted. It is
 * the same false clause `@ultimat3/schema` deleted from its own docs; this was the user-visible
 * half, one package over.
 */
export function normalizeJsonSchema(convert: () => unknown): JsonSchemaObject {
  const raw: unknown = convert();
  if (isJsonObject(raw)) return raw;
  throw new SchemaUnsupportedError({
    cause: `the schema converted to ${raw === null ? 'null' : typeof raw}, not a JSON Schema object`,
    fix: 'declare the schema with `t` from @ultimat3/action, or add an introspect() returning a SchemaNode to the object passed to configureSchemaProvider()',
  });
}

/** Key-sorted copy — deterministic ordering for the committed contract file. */
export function sortSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const parsed: unknown = JSON.parse(stableStringify(schema));
  return isJsonObject(parsed) ? parsed : {};
}
