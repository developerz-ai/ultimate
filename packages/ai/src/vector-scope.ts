// The security envelope a vector store carries: the tenant it is bound to, and the metadata
// values a policy leaves visible. Kept separate from the stores because both the in-memory dev
// store and the Postgres one must enforce the SAME envelope — a leak that only reproduces in
// production is a leak nobody finds. Deriving a scope may only ever TIGHTEN it: a scope that
// could be widened from a call site is not a scope, it is a hint.

import { VectorScopeWidenedError } from './errors';

export interface VectorScope {
  /** Bound tenant. Present ⇒ every read, write and delete carries `tenant = <this>`. */
  readonly tenant?: string | undefined;
  /**
   * A policy projected onto metadata: per key, the exact values that stay visible. Default
   * deny — a row missing the key is invisible, and an empty list matches nothing at all.
   */
  readonly allow?: Readonly<Record<string, readonly string[]>> | undefined;
}

/** The store as constructed: every tenant, every row. The backfill and migration path. */
export const UNSCOPED: VectorScope = Object.freeze({});

/** The tenant column value a row carries when its store had no tenant bound. */
export const NO_TENANT = '';

export function tenantOf(scope: VectorScope): string {
  return scope.tenant ?? NO_TENANT;
}

/**
 * Derive a narrower scope. Tenants may be SET once, never changed; allow-lists intersect, so a
 * derived scope can add a key or shrink a list but can never restore a value the parent removed.
 */
export function narrowScope(store: string, base: VectorScope, next: VectorScope): VectorScope {
  const tenant = narrowTenant(store, base.tenant, next.tenant);
  const allow = narrowAllow(base.allow, next.allow);
  return {
    ...(tenant === undefined ? {} : { tenant }),
    ...(allow === undefined ? {} : { allow }),
  };
}

function narrowTenant(
  store: string,
  base: string | undefined,
  next: string | undefined,
): string | undefined {
  if (next === undefined) return base;
  if (base === undefined || base === next) return next;
  throw new VectorScopeWidenedError({ store, held: base, requested: next });
}

/**
 * A `Map`, never a `Record`, because every key here is a CALLER's string — an app's metadata field
 * name, chosen by whoever wrote the policy. An object gets it wrong in both directions:
 *   - reading `merged['constructor']` answers the `Object` function off the prototype chain, so
 *     `held === undefined` is false and `held.includes(value)` is a bare `TypeError` raised inside
 *     a path whose only contract is `X_VECTOR_SCOPE_WIDENED`;
 *   - writing `merged['__proto__'] = [...]` runs `Object.prototype`'s setter rather than creating
 *     the key, so the rule the caller declared is absent from `Object.entries` and the derived
 *     scope comes out WIDER than the one that was asked for.
 * `Object.fromEntries` defines own properties, so the object handed back has neither hazard.
 */
function narrowAllow(
  base: Readonly<Record<string, readonly string[]>> | undefined,
  next: Readonly<Record<string, readonly string[]>> | undefined,
): Readonly<Record<string, readonly string[]>> | undefined {
  if (next === undefined) return base;
  const merged = new Map<string, readonly string[]>(Object.entries(base ?? {}));
  for (const [key, values] of Object.entries(next)) {
    const held = merged.get(key);
    merged.set(key, held === undefined ? values : values.filter((value) => held.includes(value)));
  }
  return Object.fromEntries(merged);
}

/** Whether one stored row survives the scope. The in-memory twin of the SQL conditions. */
export function scopeAdmits(
  scope: VectorScope,
  tenant: string,
  metadata: Readonly<Record<string, string>>,
): boolean {
  if (scope.tenant !== undefined && scope.tenant !== tenant) return false;
  return Object.entries(scope.allow ?? {}).every(([key, values]) => {
    // Own properties only, for the reason `narrowAllow` uses a `Map`: `key` is a caller's string
    // and a metadata bag is a caller's object. This half already failed CLOSED — an inherited
    // member is never one of the allowed strings — but relying on that is relying on the value
    // types, not on the rule, and the rule is that a caller's string is never an object key.
    const value = Object.hasOwn(metadata, key) ? metadata[key] : undefined;
    return value !== undefined && values.includes(value);
  });
}
