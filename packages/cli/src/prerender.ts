// `x build --target static` — the `site/` surface, rendered once and written as files a CDN or an
// object store can serve with no process behind it. Enumeration, hashing and the output path are
// `@ultimat3/render`'s `renderStatic`; the document is the one `x dev` serves. This file decides
// only which routes qualify and where the bytes land.

import { join } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import type { RouteEntry } from '@ultimat3/render';
import { renderStatic, routeEntries } from '@ultimat3/render';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import type { RouteStats } from './budgets';
import { measureDocumentJs, writeBuildStats } from './budgets';
import { routeDocument } from './dev-render';
import type { IslandBundle } from './island-bundle';
import { buildIslands, writeIslands } from './island-bundle';
import type { SkippedRoute } from './static-report';
import { skippedRoute, skipReasonFor, writeStaticReport } from './static-report';

/**
 * `static` only. `isr` revalidates and `ssr`/`stream` need a process, so writing any of them to
 * disk would publish a page whose staleness nothing can correct — and the route already declared
 * which of the four it is.
 *
 * DERIVED from `skipReasonFor`, never a second `=== 'static'`: the answer and the reason reported
 * beside it are one decision, and two copies of it is how a route came to be dropped silently.
 */
export const isPrerenderable = (entry: RouteEntry): boolean =>
  skipReasonFor({ surface: entry.surface, render: entry.config.render }) === null;

export interface PrerenderOptions {
  readonly root: string;
  readonly out: string;
  /** Origin the rendered `<head>` builds canonical and og:url from. */
  readonly origin?: string;
}

export interface PrerenderedPage {
  /** The DECLARED route, `/blog/:slug` — one route can write many pages, and the report groups them. */
  readonly route: string;
  readonly path: string;
  /** Relative to `out`, POSIX, as `renderStatic` computed it. */
  readonly file: string;
  readonly hash: string;
  readonly bytes: number;
}

/** A route that declared a budget and could not be rendered here, and what stopped it. */
export interface UnmeasuredRoute {
  readonly path: string;
  readonly reason: string;
}

export interface PrerenderReport {
  readonly out: string;
  readonly buildId: string;
  readonly pages: readonly PrerenderedPage[];
  /**
   * Every declared route that wrote no file, WITH the cause. A bare path list was the whole of
   * #242: `.x/static/` held a partial site, the report said only which paths were missing, and a
   * screenshot tool pointed at the directory filed "the island did not mount" against a route that
   * had never been in the artifact. The reason is what tells an author whether an edit exists.
   */
  readonly skipped: readonly SkippedRoute[];
  /**
   * Routes whose budget this build could not weigh, with the reason. `X_BUDGET_UNMEASURED` is what
   * the gate then reports for each; this is the half that says WHY, which a per-route finding read
   * off a stats file cannot know.
   */
  readonly unmeasured: readonly UnmeasuredRoute[];
  /** Where the measured stats landed, for the `budgets` gate step to read. */
  readonly stats: string;
  /** Where the emitted/skipped inventory landed, for `x build --target static` to read back. */
  readonly report: string;
  /** Client entries emitted, one chunk each. Reported so "which JS shipped?" needs no unzip. */
  readonly islands: readonly string[];
}

/**
 * The heaviest thing the document actually boots, named by the source file an author can open.
 * An island chunk is content-addressed, so its URL says nothing on its own — mapping it back
 * through the bundle is what turns `X_BUDGET_EXCEEDED` from a number into an instruction.
 */
function heaviestSource(
  bundle: IslandBundle,
  entries: readonly { readonly url: string; readonly bytes: number }[],
): readonly string[] | undefined {
  const heaviest = entries.reduce<{ url: string; bytes: number } | undefined>(
    (max, entry) => (max === undefined || entry.bytes > max.bytes ? entry : max),
    undefined,
  );
  if (heaviest === undefined) return undefined;
  const chunk = bundle.chunkAt(heaviest.url);
  return chunk === undefined ? [heaviest.url] : [chunk.file];
}

export const DEFAULT_ORIGIN = 'https://localhost';

/**
 * Prerendering and measuring are two questions, and conflating them made `X_BUDGET_UNMEASURED`
 * unclosable by any invocation: only `static` was ever rendered, so a `budget:` on an ssr, isr,
 * stream or spa route produced no `build-stats.json` entry however the build was run, and a gate
 * whose finding no command can close is a gate an author learns to ignore.
 *
 * The first question decides what lands on a CDN — `isPrerenderable`, unchanged, because a page
 * whose staleness nothing can correct must not be published. The second asks what a browser
 * executes, and every render mode makes that promise. So a budgeted route is rendered IN MEMORY
 * through the same `routeDocument` a request takes, weighed, and thrown away.
 */
const declaresBudget = (entry: RouteEntry): boolean => {
  const budget = entry.config.budget;
  return budget !== undefined && (budget.js !== undefined || budget.lcp !== undefined);
};

export async function prerenderSite(options: PrerenderOptions): Promise<PrerenderReport> {
  // The same load `x dev` and `x manifest` perform: importing the app's modules IS what fills the
  // route registry, so there is no route table to prerender before this runs.
  await loadApp(options.root);
  const buildId = (await appManifest(options.root)).manifest.buildId;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const pages: PrerenderedPage[] = [];
  const skipped: SkippedRoute[] = [];
  const routes: RouteStats[] = [];
  const unmeasured: UnmeasuredRoute[] = [];

  // Before the first document: a page's `data-x-entry` is a built chunk's URL, so the chunks have
  // to exist to be named. Written into `out` too — a static export is served with no process
  // behind it, so the artifact carries every byte the browser will ask for.
  const islands = await buildIslands(options.root);
  await writeIslands(islands, options.out);

  for (const entry of routeEntries()) {
    const facts = { surface: entry.surface, render: entry.config.render, route: entry.path };
    const reason = skipReasonFor(facts);
    if (reason !== null) {
      skipped.push(skippedRoute(facts, reason));
      if (!declaresBudget(entry)) continue;
      // Non-fatal, and that is deliberate: an ssr page's `load` may want a request, a session or a
      // database this build does not have, and a `x build --target static` that started failing on
      // routes it never used to touch would be a worse regression than the gap it closes. A route
      // that will not render here is reported, gets no stats entry, and stays `X_BUDGET_UNMEASURED`.
      try {
        const html = await routeDocument(
          entry,
          { url: new URL(entry.path, origin).href, params: {} },
          { resolveIsland: (file: string) => islands.resolverFor(file) },
        );
        const measured = await measureDocumentJs(html, options.out);
        const chain = heaviestSource(islands, measured.entries);
        routes.push({
          path: entry.path,
          jsBytes: measured.jsBytes,
          ...(chain === undefined ? {} : { heaviestChain: chain }),
        });
      } catch (error) {
        // `renderThrowable`, never `String(error)`: this is a caught unknown, and a hostile
        // `toString` here would take the whole build down instead of one route's measurement.
        unmeasured.push({ path: entry.path, reason: renderThrowable(error) });
      }
      continue;
    }
    const artifacts = await renderStatic(
      entry,
      ({ path, params }) =>
        routeDocument(
          entry,
          { url: new URL(path, origin).href, params },
          { resolveIsland: (file: string) => islands.resolverFor(file) },
        ),
      { buildId },
    );
    // `enumeratePrerender` answers `[]` for a dynamic route with no `prerender()`, so a
    // `render: 'static'` route with a param writes nothing and used to be reported NOWHERE — past
    // the skip branch by its mode, absent from `pages` by its zero artifacts. A route in neither
    // list is the defect this report exists to close, wearing its other shape.
    if (artifacts.length === 0) {
      skipped.push(skippedRoute(facts, 'no-prerender-paths'));
      continue;
    }
    for (const artifact of artifacts) {
      const file = join(options.out, artifact.outputPath);
      const bytes = await Bun.write(file, artifact.html);
      pages.push({
        route: entry.path,
        path: artifact.path,
        file: artifact.outputPath,
        hash: artifact.hash,
        bytes,
      });
      // Measured from the document that was just written, so the `budgets` step compares a
      // declared budget against bytes that exist on disk rather than against a graph's estimate.
      const measured = await measureDocumentJs(artifact.html, options.out);
      const chain = heaviestSource(islands, measured.entries);
      routes.push({
        path: artifact.path,
        jsBytes: measured.jsBytes,
        ...(chain === undefined ? {} : { heaviestChain: chain }),
      });
    }
  }
  const stats = await writeBuildStats(options.root, { routes });
  // Written LAST and by the same call that writes the stats, so an app whose `prerender.ts` does
  // not reach `prerenderSite` produces neither — and `x verify`'s `budgets` step already reds that
  // app with `X_BUDGET_UNMEASURED`, which is why this side needs no second code of its own.
  const report = await writeStaticReport(options.root, {
    target: 'static',
    out: options.out,
    buildId,
    emitted: pages.map((page) => ({ route: page.route, path: page.path, file: page.file })),
    skipped,
  });
  return {
    out: options.out,
    buildId,
    pages,
    skipped,
    unmeasured,
    stats,
    report,
    islands: islands.chunks.map((chunk) => chunk.file),
  };
}
