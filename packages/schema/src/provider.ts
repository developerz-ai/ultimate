// Single responsibility: the swap point. One provider is active per process; everything that
// consumes schemas (OpenAPI, MCP, coercion, the admin form generator) goes through `introspect`
// so a third-party library can be plugged in without touching the rest of the framework.

import { SchemaUnsupportedError } from './errors';
import { nodeOf, type SchemaNode } from './node';
import { builtinT, type TNamespace } from './validators';

export interface SchemaProvider {
  /** Matches `~standard.vendor`, e.g. `ultimate`, `arktype`, `zod`. */
  readonly vendor: string;
  readonly t: TNamespace;
  /**
   * Return the IR for one of this provider's schemas. Required for OpenAPI, MCP tool schemas
   * and the admin form generator: `toJsonSchema()` calls it unconditionally and throws
   * `X_SCHEMA_UNSUPPORTED` without it. There is no second way to describe a schema — the IR is
   * the one projection surface, and every generator reads it.
   */
  introspect?(schema: unknown): SchemaNode | undefined;
}

export const builtinProvider: SchemaProvider = Object.freeze({
  vendor: 'ultimate',
  t: builtinT,
  introspect: nodeOf,
});

let active: SchemaProvider = builtinProvider;

/**
 * Swap the library behind `t`.
 *
 * ```ts
 * import { z } from 'zod';
 * configureSchemaProvider({ vendor: 'zod', t: zodNamespace, introspect: zodToNode });
 * ```
 */
export function configureSchemaProvider(provider: SchemaProvider): void {
  active = provider;
}

export function schemaProvider(): SchemaProvider {
  return active;
}

export function resetSchemaProvider(): void {
  active = builtinProvider;
}

/**
 * The IR for any schema, whoever built it. Throws `X_SCHEMA_UNSUPPORTED` rather than silently
 * emitting an empty OpenAPI body.
 */
export function introspect(schema: unknown): SchemaNode {
  const node = active.introspect?.(schema) ?? nodeOf(schema);
  if (node === undefined) {
    throw new SchemaUnsupportedError({
      cause: `provider "${active.vendor}" cannot describe this schema as a SchemaNode`,
      fix: 'add introspect() to the object passed to configureSchemaProvider()',
      meta: { vendor: active.vendor },
    });
  }
  return node;
}

/** Best-effort variant for callers that can degrade (HTTP query coercion). */
export function tryIntrospect(schema: unknown): SchemaNode | undefined {
  return active.introspect?.(schema) ?? nodeOf(schema);
}
