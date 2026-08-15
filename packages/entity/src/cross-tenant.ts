// Single responsibility: the one explicit way to read across tenants, and the capability that
// opens it. A scope with a written reason — never a boolean argument on a repository call, which
// reads exactly like forgetting the tenant, and never a config list of exempt entities (axiom 1):
// both put the argument somewhere other than the read it defends.

// `node:` because Bun exposes no native async-context primitive: the scope has to outlive every
// `await` inside it, and `AsyncLocalStorage` is the only thing that carries a value across them.
// A module-scope flag would be shared by two concurrent requests — one of them ordinary.
import { AsyncLocalStorage } from 'node:async_hooks';
import { actorLabel, assert, hasScope, tryUseContext } from '@ultimat3/core';
import { crossTenantDenied } from './errors';

/**
 * The capability an actor must carry to read across tenants. A scope, not a role: roles are the
 * app's vocabulary and every app spells its administrator differently, while `scopes` is the
 * closed list a policy already requires against — so an operator grants this the same way they
 * grant `post:publish`, and `grep -r 'tenancy:cross'` finds every actor that holds it.
 */
export const CROSS_TENANT_SCOPE = 'tenancy:cross';

const storage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with the tenant guard lifted — every read and write it issues, at any depth and across
 * every `await`, may span tenants. For the three cases that genuinely have no single tenant: an
 * admin surface listing every org, background reconciliation, and support tooling.
 *
 * ```ts
 * // one sweep over every tenant's stale invites, nightly
 * await crossTenant('nightly invite expiry runs for every org', async () => {
 *   for await (const batch of db.invites.where({ status: 'pending' }).inBatches(500)) …
 * });
 * ```
 *
 * Three properties, none optional. **The capability is proven, always** — the actor in scope must
 * carry `tenancy:cross`, here and again at every plan built inside, so an impersonated child
 * context cannot inherit a permission its own actor never had. **Outside a request context there
 * is no actor to prove it**, so a script asking for this mints one and says who it is, which is
 * what makes a cross-tenant sweep auditable rather than ambient. **The reason is required and
 * non-blank** because it *is* the mechanism: an escape with no argument is a pragma, and the next
 * reader cannot tell a considered sweep from a forgotten tenant.
 */
export function crossTenant<T>(reason: string, fn: () => T): T {
  assert(
    reason.trim() !== '',
    'crossTenant() was given a blank reason, so the tenant guard it lifts carries no argument',
    "pass why the read spans tenants: crossTenant('nightly expiry sweeps every org', fn)",
  );
  assertCrossTenant(reason);
  return storage.run(reason, fn);
}

/**
 * The innermost enclosing reason, or `undefined` outside every scope — which is every query in an
 * app that never calls `crossTenant`. Read by the tenant guard, and by nothing else.
 */
export const crossTenantReason = (): string | undefined => storage.getStore();

/**
 * The capability check itself, run at `crossTenant()` and again for every plan built inside it.
 * Twice on purpose: `withChildContext({ actor })` swaps the actor without closing this scope, so a
 * handler that impersonates a caller inside a sweep would otherwise keep reading across tenants on
 * a permission that caller does not hold.
 */
export const assertCrossTenant = (reason: string): void => {
  const actor = tryUseContext()?.actor;
  if (actor !== undefined && hasScope(actor, CROSS_TENANT_SCOPE)) return;
  throw crossTenantDenied({
    reason,
    actor:
      actor === undefined
        ? 'no actor — the call is outside every request context'
        : actorLabel(actor),
    scope: CROSS_TENANT_SCOPE,
  });
};
