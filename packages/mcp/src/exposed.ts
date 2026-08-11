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
import { listQueries } from '@ultimat3/query';
import type { ProjectablePrimitive } from './from-action';
import { primitiveFromAction, primitiveFromQuery } from './projectable';

/**
 * Every registered action and query, as projectable primitives. `toolsFrom` applies the opt-in
 * filter, so this deliberately does NOT filter: one place decides what "exposed" means.
 *
 * Read eagerly, at the moment `defineAppMcp` runs — register the app's primitives first.
 */
export function exposedPrimitives(): readonly ProjectablePrimitive[] {
  return [...listActions().map(primitiveFromAction), ...listQueries().map(primitiveFromQuery)];
}
