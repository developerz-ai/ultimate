// File path → URL for a route file under `site/` or `app/`: the one spelling each surface accepts,
// refused with the exact move that makes the file a route. Split out of `registry.ts`, which keeps
// the table itself.

import { trimTrailingSlashes } from '@ultimat3/core/page';
import { RouteFileInvalidError, SurfaceBoundaryError } from './errors';
import type { RouteSurface, Surface } from './surfaces';
import { locateSurface } from './surfaces';

/**
 * The one filename a route may carry, per route surface. Keyed by `RouteSurface`, so both rows are
 * MANDATORY: a dropped row would read as `undefined` in `assertRouteFilename`.
 */

export const ROUTE_FILENAME = Object.freeze<Record<RouteSurface, string>>({
  site: 'page.tsx',
  app: 'page.tsx',
});

/** Stems that already meant "this directory", so the repair is a rename in place, not a new folder. */
const DIRECTORY_STEMS = new Set(['index', 'page', 'route']);

/**
 * `apps/web/site/blog/[slug]/page.tsx` → `{ surface: 'site', path: '/blog/:slug' }`.
 *
 * The URL is the **directory** path under the surface; the filename names the kind of file, never
 * a URL segment. Anything else is `X_ROUTE_FILE_INVALID` — one spelling per surface, so an agent
 * reading a folder knows which file is the route without opening any of them.
 *
 * | file | path |
 * |---|---|
 * | `site/page.tsx` | `/` |
 * | `site/pricing/page.tsx` | `/pricing` |
 * | `site/(marketing)/about/page.tsx` | `/about` |
 * | `site/blog/[slug]/page.tsx` | `/blog/:slug` |
 * | `site/docs/[...path]/page.tsx` | `/docs/*path` |
 * | `app/dashboard/page.tsx` | `/dashboard` |
 */
export function routePathFromFile(file: string): { surface: RouteSurface; path: string } {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  // One reader of the surface segment, and it answers WHERE as well as WHICH. Slicing at
  // `indexOf('app/')` instead matched inside `myapp/`, so `apps/myapp/app/page.tsx` resolved to
  // `/app` rather than `/` — the surface came from an anchored regex and the URL from a substring.
  const located = locateSurface(normalized);
  if (located === null) {
    throw new SurfaceBoundaryError(
      `${file} is not inside a surface directory, so it has no URL and no bundle graph`,
      `git mv -- ${shellQuote(file)} '<site or app>/<path>/page.tsx'   # under site/ or app/, named page.tsx`,
    );
  }
  const surface = routeSurfaceOf(normalized, located.surface);

  const rawSegments = located.rest.split('/').filter((s) => s.length > 0);
  assertRouteFilename(normalized, surface, rawSegments[rawSegments.length - 1]);

  const urlSegments = rawSegments
    .slice(0, -1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    .map(toUrlSegment);

  const path = trimTrailingSlashes(`/${urlSegments.join('/')}`) || '/';
  return { surface, path };
}

/**
 * POSIX single-quotes a filesystem-derived operand for a `fix:` command: close the quote, escape
 * an embedded quote as `'\''`, reopen it. A `fix:` is copied and run verbatim (axiom 4), so a route
 * filename carrying a space, an apostrophe or a shell metacharacter must not change what runs.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Only `site/` and `app/` hold route files. `shared/` is a leaf of helpers with no URL; `api/` is
 * the action and query projections `defineApi()` collects — a wire format an action cannot speak
 * is a plain HTTP route in the `routes` runtime override, never a file under `api/`.
 */
function routeSurfaceOf(file: string, surface: Surface): RouteSurface {
  if (surface === 'shared') {
    throw new RouteFileInvalidError(
      `${file} is under shared/, which is a leaf of helpers with no URL — a route cannot live there`,
      `git mv -- ${shellQuote(file)} '<site or app>/<path>/page.tsx'   # under site/ or app/, named page.tsx`,
    );
  }
  if (surface === 'api') {
    throw new RouteFileInvalidError(
      `${file} is under api/, which holds no route file: api/ is the actions and queries defineApi() collects`,
      `x g action '<name>'   # JSON in and out: replace ${file} with an action collected by defineApi() in api/index.ts. Another wire format (a webhook, an OAuth endpoint): delete ${file} and add a plain HTTP route to the routes array exported as runtime from apps/<app>/runtime.ts`,
    );
  }
  return surface;
}

/**
 * Enforced rather than documented (axiom 3): a convention that is not a build error is not a
 * convention. The fix is the move that makes the file a route, spelled out — the directory the
 * author already meant, plus the one filename that surface accepts.
 */
function assertRouteFilename(
  file: string,
  surface: RouteSurface,
  basename: string | undefined,
): void {
  // Own keys only: an `Object.prototype` member is never the filename a surface accepts.
  const expected = Object.hasOwn(ROUTE_FILENAME, surface)
    ? ROUTE_FILENAME[surface]
    : ROUTE_FILENAME.site;
  if (basename === expected) return;

  // The directory the author meant is the file's own path minus its extension: `site/pricing.tsx`
  // was always trying to be `/pricing`, so `site/pricing/page.tsx` is the move, not a guess.
  // `index`, `page` and `route` are the exception — each already means "this directory", so the
  // rename happens in place and no directory is created.
  const stem = file.replace(/\.(tsx|ts|jsx|js)$/, '');
  const dir = stem.slice(0, stem.lastIndexOf('/'));
  const inPlace = DIRECTORY_STEMS.has(stem.slice(dir.length + 1));
  const target = inPlace ? `${dir}/${expected}` : `${stem}/${expected}`;
  // Plain `mv`, never `git mv`. `x new --no-git` scaffolds a tree with no repository, and there the
  // shipped `git mv` answered `fatal: not a git repository` — a fix line that fails is worse than
  // no fix line, because the reader debugs git instead of moving the file. `mv` works in both
  // cases: git detects the rename at `git add` time, so the only thing given up is a nicety, and
  // the instruction is the same one either way. `-n` keeps the one guarantee `git mv` did carry:
  // an author who adds the correct `site/pricing/page.tsx` and leaves `site/pricing.tsx` behind is
  // reported against the stale file, and `target` is then the GOOD file — a clobber deletes a
  // working route, and this fix line is pasted unread.
  throw new RouteFileInvalidError(
    `${file} is a route on the ${surface} surface, so it must be named ${expected}: the URL is the ` +
      'directory path and the filename names the kind of file',
    inPlace
      ? `mv -n -- ${shellQuote(file)} ${shellQuote(target)}`
      : `mkdir -p -- ${shellQuote(stem)} && mv -n -- ${shellQuote(file)} ${shellQuote(target)}`,
  );
}

function toUrlSegment(segment: string): string {
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll?.[1] !== undefined) return `*${catchAll[1]}`;
  const dynamic = /^\[(.+)\]$/.exec(segment);
  if (dynamic?.[1] !== undefined) return `:${dynamic[1]}`;
  return segment;
}
