// Single responsibility: acting as another actor, on the record. `withChildContext({ actor })` is
// the mechanism; this is the ONE door through it, because a swap with no reason and no origin is
// indistinguishable in an audit trail from the customer doing it themselves.

import { AsyncLocalStorage } from 'node:async_hooks';
import { type Actor, actorLabel, actorOrigin } from './actor';
import { assert } from './assert';
import { useContext, withChildContext } from './context';
import { currentSpan } from './telemetry';

const storage = new AsyncLocalStorage<string>();

/**
 * Run `fn` as `actor`, recording who asked and why.
 *
 * ```ts
 * await impersonate(customer, 'ticket 4821: reproduce the failed refund', async () => { … });
 * ```
 *
 * Three properties, none optional. **The original actor is preserved** — stamped onto the child as
 * `onBehalfOf`, so every log line, span and `actorLabel()` inside renders `support:eng-7→user:…`
 * and a refund issued here can never read as the customer's. **The reason is required and
 * non-blank** because it *is* the mechanism: a swap with no argument is a pragma, and the next
 * reader cannot tell a support session from a bug. **There must be a context** — outside one there
 * is no original actor to preserve, so there is nothing to impersonate *from*, and
 * `withChildContext` says so with `X_NO_CONTEXT`.
 *
 * Same template as `@ultimat3/entity`'s `crossTenant()`, deliberately: two escapes from the
 * framework's default posture should not be two different-looking things.
 */
export function impersonate<T>(actor: Actor, reason: string, fn: () => T): T {
  assert(
    reason.trim() !== '',
    'impersonate() was given a blank reason, so the identity swap it performs carries no argument',
    "pass why one actor is acting as another: impersonate(customer, 'ticket 4821: reproduce the failed refund', fn)",
  );
  const parent = useContext();
  const impersonated: Actor = Object.freeze({ ...actor, onBehalfOf: actorOrigin(parent.actor) });
  const label = actorLabel(impersonated);
  // The PARENT's logger, because the parent is who is performing this — and `warn`, not `info`,
  // because this is rare, always interesting, and an audit query that has to read info-level to
  // find it will be run at the wrong level during the one incident where it matters.
  parent.logger.warn('impersonation', { event: 'impersonation', actor: label, reason });
  currentSpan()?.addEvent('impersonation', {
    'actor.label': label,
    'impersonation.reason': reason,
  });
  return withChildContext({ actor: impersonated }, () => storage.run(reason, fn));
}

/**
 * The innermost enclosing reason, or `undefined` outside every scope — which is every request in
 * an app where nobody is impersonating. Read by an audit sink, and by nothing else.
 */
export function impersonationReason(): string | undefined {
  return storage.getStore();
}

/** Is the caller acting as somebody else right now? */
export function isImpersonating(): boolean {
  return storage.getStore() !== undefined;
}
