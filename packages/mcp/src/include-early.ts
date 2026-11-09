// When `include: 'exposed'` was projected, and whether the registries have grown since. The boot
// scan registers each module's primitives as it reaches it, so an endpoint built at the top level
// of a module the scan evaluates early froze a catalog missing every primitive registered after —
// silently, and only in the process that booted. The mount asks here once the scan is done.

import { exposedPrimitives } from './exposed';
import { McpIncludeEarlyError } from './mount-errors';

/** Keyed on the `AppMcp` object: collected with it, and a hand-built look-alike has no entry. */
const projectedAt = new WeakMap<object, ReadonlySet<string>>();

/** `defineAppMcp`'s half: the exposed primitives `include: 'exposed'` saw, by name. */
export function noteIncluded(endpoint: object, names: readonly string[]): void {
  projectedAt.set(endpoint, new Set(names));
}

/**
 * The mount's half, after the scan: an endpoint built with `include: 'exposed'` must have seen
 * every exposed primitive registered now, or it is `X_MCP_INCLUDE_EARLY` naming the ones it
 * missed and `file`, the mount file that exported it. An endpoint without `include` is not asked.
 */
export function assertIncludeCurrent(endpoint: object, file: string): void {
  const seen = projectedAt.get(endpoint);
  if (seen === undefined) return;
  const missing = exposedPrimitives()
    .map((primitive) => primitive.name)
    .filter((name) => !seen.has(name))
    .sort();
  if (missing.length > 0) throw new McpIncludeEarlyError({ missing, file });
}
