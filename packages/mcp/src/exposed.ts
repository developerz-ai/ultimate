// `include: 'exposed'` — project straight from the primitive registries.
//
// "Define once, project everywhere". The action and query registries already know which
// primitives declared `mcp: { expose: true }`; re-listing them in `defineAppMcp` copies that
// knowledge into a second place, and a copy is a thing that goes stale silently — an action
// gains `expose`, its tool never appears, and nothing fails.
//
// The adaptation itself lives in `projectable.ts`, shared verbatim with the written-out
// `actions:`/`queries:` list, so both routes run through `invoke` / `sourceFor` and the registry
// shortcut buys convenience while changing no execution path.

import { listActions } from '@ultimat3/action';
import { isMcpExposed } from '@ultimat3/core';
import { listQueries } from '@ultimat3/query';
import type { ProjectablePrimitive } from './from-action';
import { primitiveFromAction, primitiveFromQuery } from './projectable';

/**
 * Every registered action and query that opted in, as projectable primitives — asked with core's
 * `isMcpExposed`, the one predicate `toolsFrom` asks again. Filtered BEFORE projecting: projecting
 * reserves the `idempotencyKey` argument and builds the wire schema, so an action no surface
 * serves could refuse the boot (`X_MCP_IDEMPOTENCY_KEY_SHADOWED`) of every tool that is served.
 *
 * Read eagerly, at the moment `defineAppMcp` runs — register the app's primitives first. The mount
 * asks again after the boot scan (`include-early.ts`), so a catalog built too early is refused.
 */
export function exposedPrimitives(): readonly ProjectablePrimitive[] {
  return [
    ...listActions()
      .filter((target) => isMcpExposed(target.mcp))
      .map(primitiveFromAction),
    ...listQueries()
      .filter((target) => isMcpExposed(target.mcp))
      .map(primitiveFromQuery),
  ];
}
