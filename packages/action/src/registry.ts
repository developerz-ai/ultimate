/**
 * The action registry. Names come from export names — `registerActions(module)`
 * is how a module namespace becomes named, collision-checked, projectable
 * actions. Registration is also where a missing policy becomes a build error.
 */

import type { ActionDescriptor, AnyAction } from './action';
import { isAction } from './action';
import { ActionDuplicateError, ActionPolicyMissingError } from './errors';

const registry = new Map<string, AnyAction>();

/**
 * Register one action under an explicit name. Returns the *named* twin — the
 * unnamed value you passed stays unnamed, so always use the return value.
 */
export function registerAction<A extends AnyAction>(name: string, target: A): A {
  if (registry.has(name)) throw new ActionDuplicateError(name);
  if (target.def.policy === undefined || target.def.policy === null) {
    throw new ActionPolicyMissingError(name);
  }
  const named = target.named(name) as A;
  registry.set(name, named);
  return named;
}

/**
 * Register every action exported by a module namespace, keyed by export name.
 * `registerActions(await import('./actions'))` at boot; the CLI does the same
 * during `x verify` so the manifest and the server agree by construction.
 */
export function registerActions(module: Record<string, unknown>): readonly AnyAction[] {
  const registered: AnyAction[] = [];
  for (const name of Object.keys(module).sort()) {
    const value = module[name];
    if (isAction(value)) registered.push(registerAction(name, value));
  }
  return registered;
}

export function getAction(name: string): AnyAction | undefined {
  return registry.get(name);
}

/** Sorted by name: iteration order is part of the deterministic contract output. */
export function listActions(): readonly AnyAction[] {
  return [...registry.entries()].sort(byName).map(([, value]) => value);
}

export function describeActions(): readonly ActionDescriptor[] {
  return listActions().map((target) => target.describe());
}

/** Test-only. Production registers once at boot and never unregisters. */
export function resetRegistry(): void {
  registry.clear();
}

function byName(a: readonly [string, AnyAction], b: readonly [string, AnyAction]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
