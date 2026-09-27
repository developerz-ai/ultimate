/**
 * Where an action is served: its pinned `http.path` when it declares one, else the app's
 * `pathStyle` applied to its name. The style is declared ONCE per app (`defineApi({ http:
 * { pathStyle } })`) and read lazily by every projection — the route, the OpenAPI operation, the
 * descriptor, the deprecation successor — so no projection can hold a path the others do not.
 */

import type { ActionPathStyle, ActionRoute } from '@ultimat3/core';
import { ACTION_PATH_STYLES, actionRoute } from '@ultimat3/core';
import {
  ActionHttpPathInvalidError,
  ActionPathDerivedEarlyError,
  ActionPathStyleInvalidError,
} from './errors-http';
import { defOf } from './invoke';
import { seatedActions } from './registry-store';

/**
 * Name → the pin its registered action declares, read through the registry's leaf store, so a
 * caller holding only a NAME (`derivePath`, a deprecation's `replacedBy`) gets the pinned URL.
 */
const pinOf = (name: string): string | undefined => {
  const seated = seatedActions.get(name);
  return seated === undefined ? undefined : defOf(seated).http?.path;
};

/** What an action may say about its own HTTP projection. */
export interface ActionHttp {
  /**
   * Pin the URL, whatever the app's style derives — for a path a vendor was given and cannot be
   * told to change (a webhook registered with a payment provider). Static and lowercase; the pin
   * is also what a rename of the export can no longer move.
   */
  readonly path?: string;
}

/** Static, lowercase, no parameters, no trailing slash. */
const PINNED_PATH = /^(\/[a-z0-9][a-z0-9._~-]*)+$/;

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

/** Test seam, beside `resetRegistry`. */
export function resetActionPathStyle(): void {
  style = 'resource';
  handedOut.clear();
}

/** Refuses a pin that is not a static lowercase path, or one under the framework's `/_x`. */
export function assertPinnedPath(name: string, path: unknown): void {
  if (typeof path !== 'string') {
    throw new ActionHttpPathInvalidError({ name, path, reason: 'is not a string' });
  }
  if (!PINNED_PATH.test(path)) {
    throw new ActionHttpPathInvalidError({
      name,
      path,
      reason:
        'is not a static lowercase path (a parameter, an uppercase letter or a trailing slash)',
    });
  }
  if (path === '/_x' || path.startsWith('/_x/')) {
    throw new ActionHttpPathInvalidError({
      name,
      path,
      reason: 'claims /_x, the framework namespace',
    });
  }
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
 * The route a registered NAME is served at: its pin when it declares one, else the style's. The
 * one by-name answer an app is given, so it is the one recorded — see `handedOut`.
 */
export function resolveActionRoute(name: string): ActionRoute {
  const route = routeFor(name, pinOf(name));
  handedOut.set(name, route.path);
  return route;
}
