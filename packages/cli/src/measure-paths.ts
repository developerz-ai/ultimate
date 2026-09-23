// Which URLs a route rendered only to WEIGH is rendered at. A route with no params is its own
// path. A route with params is rendered at the paths its own `prerender()` lists — the same list a
// static route writes files for — and one that lists none is not rendered at all: rendering
// `/blog/:slug` with an empty `slug` failed the page's own input schema (`X_INPUT_INVALID`), and
// that was filed as "could not be weighed", a failure of the app dressed as a gap in the build.

import type { RouteEntry } from '@ultimat3/render';
import { enumeratePrerender } from '@ultimat3/render/server';
import { quoteArg } from './shell-quote';
import type { UnmeasuredRoute } from './static-report';

/** One render the measuring pass performs: the URL path and the params it carries. */
export interface MeasurePath {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * `pattern` with each `:name` / `*name` segment filled from `params`. Values are URI-encoded per
 * segment, except a catch-all's, whose slashes are its own.
 */
export function fillPath(pattern: string, params: Readonly<Record<string, string>>): string {
  const segments = pattern.split('/').map((segment) => {
    const name = segment.slice(1);
    const value = Object.hasOwn(params, name) ? (params[name] ?? '') : '';
    if (segment.startsWith(':')) return encodeURIComponent(value);
    if (segment.startsWith('*')) return value.split('/').map(encodeURIComponent).join('/');
    return segment;
  });
  return segments.join('/') || '/';
}

/** The distinct finding for a dynamic route that gives the build nothing to render it at. */
export function paramsUndeclared(entry: RouteEntry, listed: boolean): UnmeasuredRoute {
  const keys = entry.pattern.keys;
  const example = keys.map((key) => `${key}: 'a-real-${key}'`).join(', ');
  const cause = listed
    ? `${entry.path} has dynamic params and its prerender() listed no path, so the build had nothing to render it at and weighed nothing`
    : `${entry.path} has dynamic params and declares no prerender(), so the build has no path to render it at and weighed nothing`;
  return {
    path: entry.path,
    reason: cause,
    code: 'X_BUDGET_PARAMS_UNDECLARED',
    cause,
    fix: `add prerender: () => [{ ${example} }] to defineRoute in ${quoteArg(entry.file)}, then x build --target static`,
  };
}

/** The paths to render `entry` at, or the finding that says why there are none. */
export type MeasurePlan =
  | { readonly paths: readonly MeasurePath[] }
  | { readonly unmeasured: UnmeasuredRoute };

/**
 * A `render: 'ssr'` route with params: it may not declare `prerender()` (`X_ROUTE_MODE_INVALID`),
 * so no build can hold a value to render it at. Reported as unweighable, never as a finding — there
 * is no edit to the app that a build could then measure.
 */
export const perRequestParams = (entry: RouteEntry): UnmeasuredRoute => ({
  path: entry.path,
  reason: `${entry.path} renders per request with params (${entry.pattern.keys.join(', ')}) and render: 'ssr' may not declare prerender(), so no build has a value to render it at — its budget is not enforced by x verify`,
  weighable: false,
});

export async function measurePaths(entry: RouteEntry): Promise<MeasurePlan> {
  if (entry.pattern.keys.length === 0) return { paths: [{ path: entry.path, params: {} }] };
  if (entry.config.render === 'ssr') return { unmeasured: perRequestParams(entry) };
  if (entry.config.prerender === undefined) return { unmeasured: paramsUndeclared(entry, false) };
  const sets = await enumeratePrerender(entry);
  if (sets.length === 0) return { unmeasured: paramsUndeclared(entry, true) };
  return {
    paths: sets.map((params) => ({ path: fillPath(entry.pattern.source, params), params })),
  };
}
