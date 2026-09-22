// A request's registered services (`defineService`), bound to the actor that AUTHENTICATED. The
// context exists before the `auth` stage names anyone, so core's constructor is told to install
// nothing and every registered name becomes a lazy member here instead: built on first read, and
// built again only if the actor, locale or time zone it closed over has since changed.

import type { CtxFacts, ServiceBag } from '@ultimat3/core';
import { installedServices, registeredServiceNames } from '@ultimat3/core';
import type { RequestContext } from './context';

interface Built {
  readonly actor: CtxFacts['actor'];
  readonly locale: string;
  readonly tz: string;
  readonly bag: ServiceBag;
}

/**
 * Makes `ctx.services` and each registered `ctx.<name>` lazy. Non-enumerable, so building the
 * preview a factory reads — the context's facts, no sibling service — never reads one back.
 * An explicit service (`init.services`) stays what it was: a caller's mock overrides the real one.
 */
export function bindRequestServices(ctx: RequestContext, explicit: ServiceBag): void {
  let built: Built | undefined;
  const bag = (): ServiceBag => {
    if (
      built !== undefined &&
      built.actor === ctx.actor &&
      built.locale === ctx.locale &&
      built.tz === ctx.tz
    ) {
      return built.bag;
    }
    const preview: CtxFacts = Object.freeze({
      ...explicit,
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      actor: ctx.actor,
      locale: ctx.locale,
      tz: ctx.tz,
      buildId: ctx.buildId,
      role: ctx.role,
      clock: ctx.clock,
      now: ctx.now,
      logger: ctx.logger,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      services: explicit,
    });
    const next = Object.freeze({ ...installedServices(preview), ...explicit });
    built = { actor: ctx.actor, locale: ctx.locale, tz: ctx.tz, bag: next };
    return next;
  };
  Object.defineProperty(ctx, 'services', { get: bag, enumerable: false, configurable: true });
  for (const name of registeredServiceNames()) {
    // A framework field keeps its meaning whatever an app named a service — core's rule, kept.
    if (Object.hasOwn(explicit, name) || Object.hasOwn(ctx, name)) continue;
    Object.defineProperty(ctx, name, {
      get: () => bag()[name],
      enumerable: false,
      configurable: true,
    });
  }
}
