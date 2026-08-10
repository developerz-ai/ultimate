/**
 * The query registry. Names come from export names, so the manifest, the live
 * subscription protocol and the `/_x` dashboard all address a read by the same
 * identifier the source file uses.
 */
import { registerPrimitiveRegistrar } from '@ultimat3/core';
import { QueryDuplicateError, QueryPolicyMissingError } from './errors';
import type { AnyQuery, QueryDescriptor } from './query';
import { isQuery, nameQuery } from './query';

const registry = new Map<string, AnyQuery>();

/**
 * Register one query under an explicit name. The name lands on the query you passed,
 * so the module's own export is projectable after boot and there is no "use the
 * return value instead" rule to forget.
 */
export function registerQuery<Q extends AnyQuery>(name: string, target: Q): Q {
  if (registry.has(name)) throw new QueryDuplicateError(name);
  if (target.policy === undefined || target.policy === null) {
    throw new QueryPolicyMissingError(name);
  }
  const named = nameQuery(target, name);
  registry.set(name, named);
  return named;
}

/** `registerQueries(await import('./live'))` — export names become query names. */
export function registerQueries(module: Readonly<Record<string, unknown>>): readonly AnyQuery[] {
  const registered: AnyQuery[] = [];
  for (const name of Object.keys(module).sort()) {
    const value = module[name];
    if (isQuery(value)) registered.push(registerQuery(name, value));
  }
  return registered;
}

// `defineApi` lives in `@ultimat3/action`, which sits on this tier and so cannot import this
// file. Announcing the registrar in core's table is what lets one `defineApi({ queries })` call
// register a read without a sideways import — importing the module you pass is what loads this.
registerPrimitiveRegistrar('query', registerQueries);

export function getQuery(name: string): AnyQuery | undefined {
  return registry.get(name);
}

/** Sorted by name — manifest output must not depend on import order. */
export function listQueries(): readonly AnyQuery[] {
  return [...registry.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, value]) => value);
}

export function describeQueries(): readonly QueryDescriptor[] {
  return listQueries().map((target) => target.describe());
}

/** Test-only. Production registers once at boot. */
export function resetRegistry(): void {
  registry.clear();
}
