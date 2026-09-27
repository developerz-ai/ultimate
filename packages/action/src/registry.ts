/**
 * The action registry. Names come from export names — `registerActions(module)`
 * is how a module namespace becomes named, collision-checked, projectable
 * actions. Registration is also where a missing policy becomes a build error.
 */

import type { ActionPathStyle } from '@ultimat3/core';
import { SchemaUnsupportedError } from '@ultimat3/schema';
import type { ActionDescriptor, AnyAction } from './action';
import { isAction, nameAction } from './action';
import { resetApiDeclaration } from './api-declaration';
import { ActionDuplicateError, ActionPathDuplicateError, ActionPolicyMissingError } from './errors';
import {
  assertPinnedPath,
  resetActionPathStyle,
  resolveActionRoute,
  routeFor,
  setActionPathStyle,
} from './http-path';
import { assertIdempotencyScope } from './idempotency';
import { defOf } from './invoke';
import { jsonSchemaOf, mcpSchemaOf } from './json-schema';
import type { ActionPath } from './naming';
import { seatedActions } from './registry-store';

const registry = seatedActions;

/**
 * Derived route -> the action name that owns it. A second index because the name is not the
 * path: `pluralize` leaves a trailing `s` alone by design, so `archiveOrder` and `archiveOrders`
 * are two names and one route. Nothing downstream can refuse that — the router seats whichever
 * came last and the shadowed action stays in the OpenAPI document and the MCP tool list.
 */
const paths = new Map<string, string>();

/**
 * Register one action under an explicit name. The name lands on the action you
 * passed, so the module's own export is projectable after boot and there is no
 * "use the return value instead" rule to forget.
 */
export function registerAction<A extends AnyAction>(name: string, target: A): A {
  // Boot, never the first request, and here rather than in `registerActions` because this is the
  // funnel every registration path goes through — and it necessarily runs before a route is
  // mounted. A no-op unless the app declared `scope: 'shared'`, which is the only case where the
  // framework has been told something it can check. See `assertRateLimitScope`, its twin.
  assertIdempotencyScope();
  const seated = registry.get(name);
  if (seated !== undefined) {
    // Re-registering the SAME object under the SAME name is one registration seen twice, not a
    // collision: `defineApi` registers a feature module at boot and the framework's module scan
    // reaches the same declaration file directly, so both arrive at the identical action. Only a
    // DIFFERENT action under a taken name is the ambiguity `X_ACTION_DUPLICATE` exists to refuse.
    if (seated !== (target as AnyAction)) throw new ActionDuplicateError(name);
    return target;
  }
  if (target.policy === undefined || target.policy === null) {
    throw new ActionPolicyMissingError(name);
  }
  assertProjectable(name, target);
  const pin = defOf(target).http?.path;
  if (pin !== undefined) assertPinnedPath(name, pin);
  const { path } = routeFor(name, pin);
  const owner = paths.get(path);
  if (owner !== undefined && owner !== name) {
    throw new ActionPathDuplicateError({ name, existing: owner, path });
  }
  const named = nameAction(target, name);
  registry.set(name, named);
  paths.set(path, name);
  return named;
}

/**
 * Where `target` is served — its pin, else the app's style over its name. A NAME is resolved
 * through the registry, so a pin declared on the action is honoured for a caller that only has the
 * name (a deprecation's `replacedBy`, a page minting an island's endpoint).
 */
export function actionHttpPath(target: AnyAction | string): ActionPath {
  // By NAME is how a page mints a form target, so it answers through the recorded path.
  if (typeof target === 'string') return resolveActionRoute(target);
  return routeFor(target.name, defOf(target).http?.path);
}

/**
 * The app's `pathStyle`, applied to every action already seated and every one registered after.
 * Re-derived whole, so two names the new style folds onto one URL are refused here rather than
 * left for the router to seat one of.
 */
export function configureActionPathStyle(style: ActionPathStyle): void {
  setActionPathStyle(style);
  paths.clear();
  for (const [name, target] of [...registry.entries()].sort(byName)) {
    const { path } = routeFor(name, defOf(target).http?.path);
    const owner = paths.get(path);
    if (owner !== undefined && owner !== name) {
      throw new ActionPathDuplicateError({ name, existing: owner, path });
    }
    paths.set(path, name);
  }
}

/**
 * Both schemas must reach JSON Schema, and this is where that is decided — boot, beside the policy
 * check, never the first `tools/list`. `jsonSchemaOf` used to swallow the refusal into
 * `additionalProperties: true`, so an action whose `input:` the provider cannot describe registered
 * cleanly and then published "any object accepted" on three surfaces while `validateInput` rejected
 * every payload. The shipped `X_SCHEMA_UNSUPPORTED` is re-raised rather than re-coded — the failure
 * is the provider's, and only the cause needs to say which action and which field.
 */
function assertProjectable(name: string, target: AnyAction): void {
  for (const field of ['input', 'output'] as const) {
    try {
      jsonSchemaOf(target[field]);
      mcpSchemaOf(target[field]);
    } catch {
      // The thrown value is deliberately not rendered into the cause: it is the provider's, of
      // unknown shape, and this package's own two facts — which action, which field — are the
      // ones a reader acts on.
      throw new SchemaUnsupportedError({
        cause: `${name}: \`${field}:\` cannot be projected to JSON Schema`,
        fix: `declare ${name}'s \`${field}:\` with t.object({ ... }) from @ultimat3/action or an entity's $view([...]) — both introspect — or call configureSchemaProvider() with a provider that can introspect it`,
        meta: { action: name, field },
      });
    }
  }
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
  paths.clear();
  resetActionPathStyle();
  resetApiDeclaration();
}

function byName(a: readonly [string, AnyAction], b: readonly [string, AnyAction]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
