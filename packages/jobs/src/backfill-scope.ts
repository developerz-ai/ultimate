// Which sweeps run across tenants, and the capability that lets them. ONLY a `backfill()` that
// declared `tenant: 'none'`, and only for the duration of its own pass.
//
// It has to be opened HERE and nowhere else: `source` hands back a lazy chain, so every page's plan
// is built inside the iteration — long after the declaring frame closed — and `scopedPlan` is
// applied at plan-build time. An app author holding a `ReadBuilder` has nothing to wrap.

import type { Actor, Ctx } from '@ultimat3/core';
import { runWithContext } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, crossTenant } from '@ultimat3/entity';
import type { BackfillInput } from './backfill';
import type { JobTenant } from './tenant';
import { NO_JOB_TENANT } from './tenant';

/**
 * Derived and specific, because it lands in the audit trail: `assertCrossTenant` renders it in
 * `X_TENANCY_CROSS_DENIED` and it is what a reader sees when they ask why a plan skipped its
 * tenant. "backfill" alone would name every sweep in the app identically.
 */
const reasonFor = (name: string): string =>
  `backfill "${name}" declared tenant: 'none', so its pass sweeps every tenant's rows`;

/**
 * The capability, added to the run's own actor and to nothing else. `executeJob` already stripped
 * the org for a `'none'` job, so this is the one fact that changes — and it changes on an actor
 * this pass built, inside a context that dies with it.
 */
const withCrossTenant = (actor: Actor): Actor =>
  actor.scopes.includes(CROSS_TENANT_SCOPE)
    ? actor
    : Object.freeze({ ...actor, scopes: Object.freeze([...actor.scopes, CROSS_TENANT_SCOPE]) });

/**
 * Run `pass` with the tenant guard lifted, but ONLY for a backfill that declared `tenant: 'none'`.
 * A backfill that declared a real tenant is handed its context untouched and never sees the
 * escape hatch — granting one to a tenanted sweep would hand every backfill in the app the
 * capability, which is the opposite of what declaring a tenant means.
 *
 * **Why the grant lives here and not on the worker's actor.** The alternative is for boot to mint
 * a worker identity carrying `tenancy:cross` (`packages/cli/src/dev-roles.ts` builds that context).
 * That grants it to EVERY job the worker claims — including a plain `job({ tenant: 'none' })` that
 * declared no sweep at all — and puts the decision in deployment config, where no reviewer sees it
 * and one identity again serves every job. Here it is bounded four ways: only `backfill()`, only
 * on an explicit `tenant: 'none'`, only for this pass, and only on a context that does not outlive
 * it. The declaration is code in the app's own repository, carries a name the `x_backfills` ledger
 * records, and is enumerated by `x db backfill --pending` — so the sweep that gets the capability
 * is the one an operator can already see.
 *
 * `runWithContext` OUTSIDE `crossTenant`, never the other way round: `crossTenant` proves the
 * capability against the AMBIENT actor at the call and `assertCrossTenant` proves it again for
 * every plan built inside, so the scoped context has to be installed before either look.
 *
 * Nesting is safe: an app `handle` that opens its own `crossTenant(reason, fn)` replaces the reason
 * for the plans inside it and re-proves the same capability, which this actor already carries.
 */
export function withBackfillScope<T>(
  name: string,
  tenant: JobTenant<BackfillInput>,
  ctx: Ctx,
  pass: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  if (tenant !== NO_JOB_TENANT) return pass(ctx);
  // Spread and `runWithContext`, the same shape `executeJob` builds the run's context with, rather
  // than `withChildContext`: the pass is also driven directly by tests and by tooling that has no
  // ambient context for a child to derive from, and one mechanism in both places is one fewer way
  // for the run's actor and the ambient actor to disagree.
  const scoped: Ctx = Object.freeze({ ...ctx, actor: withCrossTenant(ctx.actor) });
  return runWithContext(scoped, () => crossTenant(reasonFor(name), () => pass(scoped)));
}
