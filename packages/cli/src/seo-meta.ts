// Single responsibility: the app's `site/` routes as `@ultimat3/seo` reads them.
//
// The two shapes only meet here. `RouteRecord.meta` is a STATIC object, and `defineRoute({ meta })`
// is an async function of the route's own data — so somebody has to call one to get the other, and
// this is the only tier that can see both: `@ultimat3/seo` is tier 1 and may not import the route
// registry, which is tier 4.

import { metaContextFor, type RouteEntry, routeDataFor, routeEntries } from '@ultimat3/render';
import type { RouteRecord } from '@ultimat3/seo';
import { loadApp } from './app-load';
import type { Finding } from './output';
import { findingFrom } from './output';

/**
 * Why a `site/` route's metadata cannot be read without running the app.
 *
 * Neither is a defect — both are routes whose `<head>` is a function of data that does not exist
 * until a request does. They are reported rather than dropped, because a gate that silently checks
 * two of five routes and says "ok" is worse than one that says which three it could not reach.
 */
export type UnresolvedReason = 'declares-load' | 'dynamic';

export interface UnresolvedRoute {
  readonly path: string;
  readonly file: string;
  readonly reason: UnresolvedReason;
}

export interface SiteMetaScan {
  /** Routes whose meta resolved, in the shape `validateMeta` takes. */
  readonly records: readonly RouteRecord[];
  readonly unresolved: readonly UnresolvedRoute[];
  /** A route whose `meta()` THREW — a page that cannot render its own head. */
  readonly findings: readonly Finding[];
}

/**
 * The origin `meta` is called with. Reserved by RFC 6761 and resolvable by nothing, deliberately:
 * an app has no configured base URL (`packages/core/src/config.ts` declares none), so any real
 * origin here would be this file inventing one — and a `canonical` compared against an invented
 * origin is a finding nobody can act on. `validateMeta` is therefore called with no `baseUrl` and
 * skips canonical checks; `absoluteUrl` never sees this string.
 */
const PROBE_ORIGIN = 'https://verify.invalid';

const reasonFor = (entry: RouteEntry): UnresolvedReason | undefined => {
  if (entry.pattern.keys.length > 0) return 'dynamic';
  // A `load` is a database read. Running one inside `x verify` would make the gate need a live
  // database to answer a question about text, and would run app queries nobody asked for.
  if (entry.config.load !== undefined) return 'declares-load';
  return undefined;
};

/**
 * Read every `site/` route's metadata, without rendering and without touching a database.
 *
 * `routeDataFor` hands a no-`load` route its own context back as the data — that is exactly what
 * `defineRoute`'s `LoadRequirement` guarantees — so `meta` gets the same argument here that it gets
 * in `x dev` and in the prerenderer, from the same two builders both of those use.
 */
export async function scanSiteMeta(root: string): Promise<SiteMetaScan> {
  await loadApp(root);
  return await readSiteMeta();
}

/**
 * The same scan over the registry as it stands, without loading anything.
 *
 * Split from `scanSiteMeta` so the resolution rules are testable against routes registered by hand:
 * the half worth pinning is which routes are reachable and what happens when one throws, and
 * neither of those is a fact about globbing a directory.
 */
export async function readSiteMeta(): Promise<SiteMetaScan> {
  const records: RouteRecord[] = [];
  const unresolved: UnresolvedRoute[] = [];
  const findings: Finding[] = [];

  for (const entry of routeEntries()) {
    if (entry.surface !== 'site') continue;
    const reason = reasonFor(entry);
    if (reason !== undefined) {
      unresolved.push({ path: entry.path, file: entry.file, reason });
      continue;
    }
    const ctx = { url: `${PROBE_ORIGIN}${entry.path}`, params: {} };
    try {
      const meta = await entry.config.meta(
        metaContextFor(ctx, await routeDataFor(entry.config, ctx)),
      );
      records.push({
        path: entry.path,
        file: entry.file,
        surface: 'site',
        render: entry.config.render,
        meta,
      });
    } catch (error) {
      // `findingFrom`, not a code of this file's own: a `meta` that throws an `UltimateError` has
      // already said what broke and how to fix it, and a wrapper would bury both. Anything else
      // becomes `X_CLI_UNEXPECTED` through core's total renderer.
      findings.push({ ...findingFrom(error), at: entry.file });
    }
  }
  return { records, unresolved, findings };
}
