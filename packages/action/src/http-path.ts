/**
 * Where an action is served: its pinned `http.path` when it declares one, else the app's
 * `pathStyle` applied to its name. The style is declared ONCE per app (`defineApi({ http:
 * { pathStyle } })`) and read lazily by every projection — the route, the OpenAPI operation, the
 * descriptor, the deprecation successor — so no projection can hold a path the others do not.
 */

import type { ActionPathStyle, ActionRoute } from '@ultimat3/core';
import {
  ACTION_PATH_STYLES,
  actionRoute,
  fillTemplate,
  pathTemplateProblem,
  renderCauseValue,
  templateKeyProblem,
  templateParams,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { tryIntrospect } from '@ultimat3/schema';
import type { AnyAction } from './action';
import {
  ActionHttpPathInvalidError,
  ActionPathDerivedEarlyError,
  ActionPathStyleInvalidError,
} from './errors-http';
import { defOf } from './invoke';
import { jsonSchemaOf } from './json-schema';
import { seatedActions } from './registry-store';

/**
 * Name → the pin its registered action declares, read through the registry's leaf store, so a
 * caller holding only a NAME (`derivePath`, a deprecation's `replacedBy`) gets the pinned URL.
 */
const pinOf = (name: string): string | undefined => {
  const seated = seatedActions.get(name);
  return seated === undefined ? undefined : defOf(seated).http?.path;
};

/** The verbs a pinned action may answer. `POST` is every unpinned action's, and the default. */
export const ACTION_HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ActionHttpMethod = (typeof ACTION_HTTP_METHODS)[number];

/** What an action may say about its own HTTP projection. */
export interface ActionHttp {
  /**
   * Pin the URL, whatever the app's style derives — for a path a caller already holds and cannot
   * be told to change, or a public `/v1` shaped by resource (`/orders/:id/refund`). Lowercase
   * static segments and `:param`s, each a REQUIRED string key of `input:`: the URL's value is merged
   * into the input before it is parsed, so the one schema validates it and the policy, the row
   * loader and the handler read one object. The pin is also what a rename of the export can no
   * longer move. A vendor's webhook goes to `webhookReceiver()` (`@ultimat3/jobs`) instead: an
   * action's schema answers before any signature is checked.
   */
  readonly path?: string;
  /** The verb the pin answers: `'POST'` (default), `'PUT'`, `'PATCH'` or `'DELETE'`. Needs `path`. */
  readonly method?: ActionHttpMethod;
}

/** The method `target` is served with: its pin's, else `POST`. */
export function methodOfHttp(http: ActionHttp | undefined): ActionHttpMethod {
  return http?.method ?? 'POST';
}

let style: ActionPathStyle = 'resource';

/**
 * Every path handed out BY NAME (`derivePath`, `actionHttpPath('name')`), by name. A caller may
 * keep the string — a page's form target in a module-level const — so a later style that moves
 * one of these is a URL no route serves; `setActionPathStyle` refuses it instead. Bounded by the
 * number of action names, and a path the new style keeps is not a stale one.
 */
const handedOut = new Map<string, string>();

/** The app's declared style — `'resource'` until `defineApi` says otherwise. */
export function actionPathStyle(): ActionPathStyle {
  return style;
}

/** Called by `defineApi` (and the registry's re-derivation). Refuses an unknown style. */
export function setActionPathStyle(next: unknown): ActionPathStyle {
  if (!ACTION_PATH_STYLES.some((known) => known === next)) {
    throw new ActionPathStyleInvalidError(next);
  }
  const declared = next as ActionPathStyle;
  if (declared !== style) {
    const stale = [...handedOut]
      .map(([name, was]) => ({ name, was, now: routeUnder(declared, name, pinOf(name)).path }))
      .filter((row) => row.now !== row.was)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (stale.length > 0) throw new ActionPathDerivedEarlyError({ style: declared, stale });
  }
  style = declared;
  return style;
}

/** Test seam, beside `resetActions`. */
/**
 * Forget which paths were handed out, keeping the style. `@ultimat3/testing` calls it between two
 * test files of one worker (22.7, no `--isolate`): a path an earlier FILE derived is not one this
 * file's boot handed out, and the app's `defineApi({ pathStyle })` — evaluated once per worker, by
 * whichever file first imports it — must not be refused over it.
 */
export function forgetHandedOutActionPaths(): void {
  handedOut.clear();
}

export function resetActionPathStyle(): void {
  style = 'resource';
  handedOut.clear();
}

/**
 * Refuses a pin that is not a lowercase template, claims `/_x`, repeats a `:param`, or names a
 * `:param` that is not a required string key of `input` — core's one rule, shared with
 * `@ultimat3/query`. No `input` given proves no key, so a parameterised pin is refused then.
 */
export function assertPinnedPath(name: string, path: unknown, input?: unknown): void {
  const reason =
    pathTemplateProblem(path) ??
    templateKeyProblem(
      templateParams(path as string),
      input === undefined ? undefined : tryIntrospect(input)?.properties,
    );
  if (reason !== undefined) throw new ActionHttpPathInvalidError({ name, path, reason });
}

/** The whole declaration: the path as above, and a method only beside a path, from the four. */
export function assertPinnedHttp(name: string, http: ActionHttp, input: unknown): void {
  const method: unknown = http.method;
  if (method !== undefined && http.path === undefined) {
    throw new ActionHttpPathInvalidError({
      name,
      path: http.path,
      reason: `is absent, and http.method ${renderCauseValue(method)} has no pinned path to answer on`,
    });
  }
  if (method !== undefined && !ACTION_HTTP_METHODS.some((known) => known === method)) {
    throw new ActionHttpPathInvalidError({
      name,
      path: http.path,
      reason: `is declared with http.method ${renderCauseValue(method)}, which is not one of ${ACTION_HTTP_METHODS.join(', ')}`,
    });
  }
  if (http.path !== undefined) assertPinnedPath(name, http.path, input);
}

/** `{ path, method }` exactly when `target` pins its URL — the manifest's fact, absent otherwise. */
export function actionHttpPinOf(
  target: AnyAction,
): { readonly path: string; readonly method: ActionHttpMethod } | undefined {
  const http = defOf(target).http;
  return http?.path === undefined ? undefined : { path: http.path, method: methodOfHttp(http) };
}

/**
 * The route for `name` under the current style, with `pin` replacing the path when present. The
 * verb and resource stay the style's — they label the operation, the path is where it lives.
 */
export function routeFor(name: string, pin: string | undefined): ActionRoute {
  return routeUnder(style, name, pin);
}

const routeUnder = (under: ActionPathStyle, name: string, pin: string | undefined): ActionRoute => {
  const derived = actionRoute(name, under);
  return pin === undefined ? derived : { ...derived, path: pin };
};

/**
 * The route a registered NAME is served at, for the framework's own projections — the route
 * table, the OpenAPI operation, a deprecation's successor. Re-derived on every call and never
 * held by app code, so nothing is recorded: a test that mounted routes must not make a later
 * test's style declaration look like a stranded capture.
 */
export function servedActionRoute(name: string): ActionRoute {
  return routeFor(name, pinOf(name));
}

/**
 * The same answer, handed to APP code by name (`derivePath`, `actionHttpPath('name')`) — which
 * may keep the string, so it is the one recorded; see `handedOut`.
 */
export function resolveActionRoute(name: string, params?: unknown): ActionRoute {
  const route = filledRoute(name, servedActionRoute(name), params);
  handedOut.set(name, route.path);
  return route;
}

/**
 * A parameterised route with its `:param`s filled from `params`, each encoded as one segment. No
 * values for a template is refused, never answered with `:id` spelled into a URL nothing serves.
 */
export function filledRoute(name: string, route: ActionRoute, params: unknown): ActionRoute {
  if (templateParams(route.path).length === 0) return route;
  const filled = fillTemplate(route.path, params);
  if (filled.ok) return { ...route, path: filled.path };
  throw new ActionHttpPathInvalidError({
    name,
    path: route.path,
    reason: `:${filled.missing} ${filled.reason}`,
    fix: `actionHttpPath('${name}', { ${filled.missing}: '<value>' }) — or call ${name}.client(options), which fills it from the input`,
  });
}

/**
 * A `:param` pin's OpenAPI parameters, `in: path` and required, in template order, each with its
 * input member's own schema — the request body's component drops the same keys (`openapi.ts`).
 */
export function pathParametersOf(
  path: string,
  input: StandardSchemaV1,
): readonly Record<string, unknown>[] {
  const params = templateParams(path);
  if (params.length === 0) return [];
  const properties = jsonSchemaOf(input)['properties'];
  const members: Readonly<Record<string, unknown>> =
    typeof properties === 'object' && properties !== null ? { ...properties } : {};
  return params.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: Object.hasOwn(members, name) ? members[name] : { type: 'string' },
  }));
}
