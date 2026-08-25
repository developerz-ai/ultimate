// Single responsibility: named service factories that `createContext` installs automatically,
// bound to the exact ctx (actor, clock, tz) they were built for.
//
// A service closes over the `ctx` it was constructed with — `ctx.actor.orgId` inside it means
// "the actor this service was built for", not "whoever is calling right now". So a factory
// cannot be built once and cached: it has to run again every time `createContext` produces a
// ctx with a different actor, or an impersonated call would read the wrong tenant. Registering
// with `defineService` is what lets `createContext` do that automatically instead of every
// caller wiring `services: { posts: postsService(ctx) }` by hand at every call site.

import type { CtxFacts, ServiceBag } from './context';
import { UltimateError } from './errors';

/**
 * `CtxFacts` and not `Ctx`: this factory runs INSIDE `createContext`, against a preview that
 * carries no other registered service — which the paragraph above has always said and the type
 * now enforces. It is also what lets `createContext` build that preview without an assertion.
 */
export type ServiceFactory<T = unknown> = (ctx: CtxFacts) => T;

const factories = new Map<string, ServiceFactory>();

/**
 * Register a named service factory, once per app boot — importing the module that calls this
 * IS the registration, the same convention `registerActions` uses. Returns the factory
 * unchanged, so `export const postsService = defineService('posts', (ctx) => ({...}))` still
 * exports a plain callable a test can invoke directly, without going through a context at all.
 */
export function defineService<T>(name: string, factory: ServiceFactory<T>): ServiceFactory<T> {
  if (factories.has(name)) {
    throw new UltimateError({
      code: 'X_SERVICE_DUPLICATE',
      cause: `a service named "${name}" is already registered`,
      fix: `rename one of the two defineService('${name}', ...) declarations`,
      meta: { name },
    });
  }
  factories.set(name, factory as ServiceFactory);
  return factory;
}

/**
 * Whether `name` is a registered factory. `withChildContext` uses this so an impersonated
 * child never carries forward a parent's instance built for a different actor — only ad hoc
 * services nobody registered (a test's hand-built mock) survive the swap unrebuilt.
 */
export function isManagedService(name: string): boolean {
  return factories.has(name);
}

/**
 * Every registered factory, called fresh against `ctx`. `ctx` carries no other registered
 * service yet — a factory reads the ambient actor/clock/tz, never a sibling service, so
 * factories cannot depend on one another's instances.
 */
export function installedServices(ctx: CtxFacts): ServiceBag {
  if (factories.size === 0) return {};
  const bag: Record<string, unknown> = {};
  for (const [name, factory] of factories) bag[name] = factory(ctx);
  return Object.freeze(bag);
}

/** Test-only. Production registers once at boot and never unregisters. */
export function resetServices(): void {
  factories.clear();
}
