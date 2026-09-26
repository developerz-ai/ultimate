// `x build --target static` — the `site/` surface, rendered once and written as files a CDN or an
// object store can serve with no process behind it. Enumeration, hashing and the output path are
// `@ultimat3/render`'s `renderStatic`; the document is the one `x dev` serves. This file decides
// only which routes qualify and where the bytes land.

import { join } from 'node:path';
import {
  createContext,
  DEFAULT_ENVIRONMENT,
  isUltimateError,
  renderThrowable,
  runWithContext,
  tryResolveEnvironment,
} from '@ultimat3/core';
import { localeConfig, localizedPath, routedLocales } from '@ultimat3/i18n';
import type { RouteEntry } from '@ultimat3/render';
import { describeRoutes, routeEntries } from '@ultimat3/render';
import { renderStatic } from '@ultimat3/render/server';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import type { RouteStats } from './budgets';
import { measureDocumentJs, writeBuildStats } from './budgets';
import { errorPageDocument, STATIC_ERROR_PAGE } from './error-pages';
import { FAVICON_PATH, faviconBytes } from './favicon';
import type { IslandBundle } from './island-bundle';
import { buildIslands, writeIslands } from './island-bundle';
import { measureDatabase } from './measure-database';
import { measurePaths } from './measure-paths';
import { measureScope, withAppUrl } from './measure-scope';
import { localizedArtifacts } from './prerender-locales';
import { clearPrerenderOut } from './prerender-out';
import { loadPwaArtifacts, writePwaIcons } from './pwa-artifacts';
import { routeDocument } from './runtime-render';
import { writeSiteAssets } from './site-assets';
import { loadSiteSettings, originWarning, publicOrigin } from './site-config';
import type { SkippedRoute, UnmeasuredRoute } from './static-report';
import { skippedRoute, skipReasonFor, writeStaticReport } from './static-report';
import { styleBundle, writeStyles } from './style-bundle';
import type { RenderedDocument } from './sw-artifacts';
import {
  SERVICE_WORKER_PATH,
  SW_REGISTER_PATH,
  serviceWorkerArtifacts,
  serviceWorkerHead,
  serviceWorkerRegistration,
} from './sw-artifacts';
import { loadThemeMode, themeBoot } from './theme-boot';

// Re-exported, never re-declared: `static-report.ts` owns the shape because the report on disk
// carries it, and this file already imports that module.
export type { UnmeasuredRoute };

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
  /**
   * Origin the rendered `<head>` builds canonical, og:url and hreflang from. Absent: `APP_URL`,
   * `SITE_ORIGIN`, then `site.origin` from `app.config.ts`, then `DEFAULT_ORIGIN` — with a warning
   * on a production build, because a placeholder canonical is one a search engine indexes.
   */
  readonly origin?: string;
}

export interface PrerenderedPage {
  /** The DECLARED route, `/blog/:slug` — one route can write many pages, and the report groups them. */
  readonly route: string;
  /** The URL the page is served at — `/en/pricing` for a non-default locale. */
  readonly path: string;
  /** The locale the page was rendered in. */
  readonly locale: string;
  /** Relative to `out`, POSIX — under `<locale>/` for a non-default locale. */
  readonly file: string;
  readonly hash: string;
  readonly bytes: number;
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
  /** Surface stylesheets emitted, one file each — the CSS half of the same question. */
  readonly styles: readonly string[];
  /**
   * What the service worker could not express, and what its precache manifest weighs too much of.
   *
   * `PrecacheManifest.warnings` had no reader anywhere in the tree — the precache budget was, in
   * `wiki/Troubleshooting.md`'s own words, "a designed thing that is not one" (#390). An install
   * that stalls on a bad connection is invisible on a laptop and fatal on a phone, so the number
   * has to reach the build's own report. Empty for an app with no service worker.
   */
  readonly serviceWorkerWarnings: readonly string[];
  /** What this build could not get right on its own — today, a production build with no origin. */
  readonly warnings: readonly string[];
  /** The origin every absolute URL in the export was built against — hand it to `siteSeo`. */
  readonly origin: string;
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

/** The one status a static export can answer for itself: a path that matches no file. */
const NOT_FOUND_STATUS = 404;

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
  // Emptied FIRST: the export only ever gained files, so a deleted route's HTML kept shipping.
  await clearPrerenderOut(options.out, options.root);
  await loadApp(options.root);
  const buildId = (await appManifest(options.root)).manifest.buildId;
  const declaredOrigin =
    options.origin ?? publicOrigin(process.env, await loadSiteSettings(options.root));
  const origin = declaredOrigin ?? DEFAULT_ORIGIN;
  // Written to stderr as well as returned: an app's `prerender.ts` prints its report as ONE JSON
  // line on stdout, and a build that parses it must not meet a warning inside it.
  const warnings = originWarning(tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT, declaredOrigin);
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  // After `loadApp`: `defineCatalogs()` configures the locales on the app's own import. The
  // default first, so every other pass writes beside a tree that already holds the unprefixed one.
  const locales = routedLocales();
  const defaultLocale = localeConfig().fallback;
  const pages: PrerenderedPage[] = [];
  const skipped: SkippedRoute[] = [];
  const routes: RouteStats[] = [];
  const unmeasured: UnmeasuredRoute[] = [];
  // What the loop below rendered, by the path it rendered — the service worker's precache
  // revisions. A `Map` and not a record, so a route path spelling a prototype member cannot answer
  // with one; insertion order is never read, because `pwaRoutes` walks the route table and
  // `buildPrecacheManifest` sorts its own entries by code unit.
  const documents = new Map<string, RenderedDocument>();

  // Before the first document: a page's `data-x-entry` is a built chunk's URL, so the chunks have
  // to exist to be named. Written into `out` too — a static export is served with no process
  // behind it, so the artifact carries every byte the browser will ask for.
  const islands = await buildIslands(options.root);
  await writeIslands(islands, options.out);
  // And the stylesheet every document below LINKS. Derived after the island build on purpose:
  // `islandStylesPlugin` registers an island's own `.module.scss` during `Bun.build`, so a bundle
  // minted before it would hash CSS the documents do not carry — and the export would publish
  // pages whose `<link>` names a file the artifact does not have.
  const styles = styleBundle();
  await writeStyles(styles, options.out);
  // The hashed `site/assets/**` copies every document's `asset()` URL names — once, never per
  // locale: an asset is the same bytes in every language, so `/en/` pages link the root's copy.
  writeSiteAssets(options.root, options.out);
  // Same rule, one asset further: a browser asks for `/favicon.ico` on the first page it loads,
  // and a static export has no route to answer it — so the bytes the served surfaces would have
  // returned go into the artifact instead of leaving a 404 in every visitor's console.
  await Bun.write(
    join(options.out, FAVICON_PATH.slice(1)),
    (await faviconBytes(options.root)).bytes,
  );
  // And the one error page a static host serves ITSELF: `404.html` at the export root is what S3,
  // Cloudflare Pages, Netlify and nginx all reach for when a path matches no file. The app's own
  // file if it wrote one, the framework's page otherwise — the same two rungs the served process
  // answers a 404 with, so the artifact and the server cannot disagree about one document.
  await Bun.write(
    join(options.out, STATIC_ERROR_PAGE),
    await errorPageDocument(options.root, NOT_FOUND_STATUS),
  );
  // And the file every document above is about to name. A static export is served with no process
  // behind it, so `<link rel="manifest">` resolves to a 404 unless the bytes are in the artifact —
  // an installable app that is installable only under `x dev` is the dev/prod split this whole
  // wiring exists to close. `undefined` when the app is not installable, and then no document
  // names it either.
  const pwa = await loadPwaArtifacts(options.root);
  const theme = themeBoot(await loadThemeMode(options.root));
  // The registration TAG now, the worker itself after the render loop — the two halves are wanted
  // at different moments and used to be taken at the same one. Every document below has to name
  // `/x-sw-register.js`, and the worker's precache manifest is built from the content hash of
  // those same documents, which do not exist yet: emitted here, every route's revision was the
  // BUILD ID and every route's byte count was 0, so a deploy of a byte-identical site re-fetched
  // everything and the precache budget could not count one byte of HTML (`precache.ts`' own
  // header). `serviceWorkerHead` is the one predicate behind both, so a page can never name a
  // script the export does not carry.
  const swHead = pwa === undefined ? undefined : serviceWorkerHead(pwa);
  // The registration's BYTES now too, and not beside `sw.js` at the end. Every document below
  // names this file and `measureDocumentJs` weighs it off disk, so writing it last made the
  // measurement read whatever happened to be there: nothing on a clean `out` (recorded as 0) and
  // the PREVIOUS build's copy on a reused one. That is the run-order dependence the `jsBytes`
  // split removed, and it came straight back in `frameworkJsBytes` because the field changed and
  // the ORDER did not. `serviceWorkerRegistration()` depends on two constants and no document, so
  // it has nothing to wait for; `sw.js` still comes last, because its precache manifest really is
  // built from the hashes of pages that do not exist yet.
  if (swHead !== undefined) {
    await Bun.write(join(options.out, SW_REGISTER_PATH.slice(1)), serviceWorkerRegistration());
  }
  if (pwa !== undefined) {
    // One per routed locale — `/en/manifest.webmanifest` beside the default one — each at the
    // path its own documents link.
    for (const manifest of pwa.manifests) {
      await Bun.write(join(options.out, manifest.path.slice(1)), manifest.body);
    }
    // And the icons that manifest NAMES. A static host runs no `assetRoutes()`, so every
    // `/icons/*` entry would be a 404 in the install prompt — the manifest half of the same
    // promise `favicon.ico` above keeps. Nothing when the app committed no source icon, which is
    // also when the manifest names no icon.
    await writePwaIcons(options.root, options.out);
  }

  // Every render below goes through `routeDocument`, which is the function a REQUEST reaches — and
  // a request arrives inside `runWithContext`, installed by the HTTP pipeline (`runtime-render.ts`).
  // Called bare, any route whose component, `load` or `meta` reads `useContext()` threw
  // `X_NO_CONTEXT`: measured against `examples/dummy`, `/posts/new` and `/settings` were filed
  // unmeasured for that reason alone, and a `render: 'static'` route reading it failed the whole
  // build. One context for the build, `role: 'web'` because that is the role serving these
  // documents, and this build's own id so a component reading `ctx.buildId` stamps the artifact
  // with the id the report and the stats carry.
  // ONE PER LOCALE, and the locale is the context's: `createContext` defaults it to core's `en`, so a
  // Spanish-default site was prerendered in English — `<html lang="en">` over English copy — while
  // the served process answered Spanish. Each `site/` page is rendered once per routed locale.
  const contexts = new Map(
    locales.map((locale) => [locale, createContext({ role: 'web', buildId, locale })]),
  );
  // A SECOND scope, for the branch below that renders only to weigh (`measure-scope.ts`): a
  // request context holding the app's measurement actor, with the app's own API answered in
  // process, because an `app/` page's `load` calls policy-guarded queries over its typed client
  // and no server is listening during a build. `renderStatic` keeps `ctx`: its output is a
  // published file, and a `site/` load a policy refuses must fail the build, never render another
  // actor's rows into it.
  const measure = await measureScope({ origin, buildId });
  // Started on the first route that needs weighing, and released however the loop ends.
  const database = measureDatabase(options.root);
  const render = (entry: RouteEntry, data: { url: string; params: Record<string, string> }) =>
    routeDocument(entry, data, {
      resolveIsland: (file: string) => islands.resolverFor(file),
      themeHead: theme.head,
      origin,
      ...(pwa === undefined
        ? {}
        : { pwaHead: (locale: string) => pwa.headFor(locale) + (swHead ?? '') }),
    });
  const document = (
    locale: string,
    entry: RouteEntry,
    data: { url: string; params: Record<string, string> },
  ) =>
    runWithContext(contexts.get(locale) ?? createContext({ role: 'web', buildId, locale }), () =>
      render(entry, data),
    );

  try {
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
          // A dynamic route is rendered at the paths its own `prerender()` lists, and the row holds
          // the heaviest — a static route's rule. One that lists none is its own finding.
          // Inside the measuring scope: a route's `prerender()` lists its paths by reading the app's
          // own data, the same way its `load` does.
          await database.ready();
          const plan = await withAppUrl(origin, () => measure.run(() => measurePaths(entry)));
          if ('unmeasured' in plan) {
            unmeasured.push(plan.unmeasured);
            continue;
          }
          let row: RouteStats | undefined;
          for (const { path, params } of plan.paths) {
            const data = { url: new URL(path, origin).href, params };
            const html = await withAppUrl(origin, () => measure.run(() => render(entry, data)));
            const measured = await measureDocumentJs(html, options.out);
            if (row !== undefined && measured.jsBytes <= row.jsBytes) continue;
            const chain = heaviestSource(islands, measured.entries);
            row = {
              path: entry.path,
              jsBytes: measured.jsBytes,
              frameworkJsBytes: measured.frameworkBytes,
              ...(chain === undefined ? {} : { heaviestChain: chain }),
            };
          }
          if (row !== undefined) routes.push(row);
        } catch (error) {
          // `renderThrowable`, never `String(error)`: this is a caught unknown, and a hostile
          // `toString` here would take the whole build down instead of one route's measurement.
          // A framework error rides along with its code, cause and fix: `checkBudgets` reports
          // `X_ISLAND_PROPS_INVALID` under its own name, because that sentence — the island, the
          // prop, its bytes — is the finding, and `X_BUDGET_UNMEASURED` pointing at this list was
          // a second command between the author and it.
          unmeasured.push({
            path: entry.path,
            reason: renderThrowable(error),
            ...(isUltimateError(error)
              ? { code: error.code, cause: error.cause, fix: error.fix }
              : {}),
          });
        }
        continue;
      }
      const artifacts = await localizedArtifacts(locales, defaultLocale, (locale) =>
        renderStatic(
          entry,
          ({ path, params }) =>
            document(locale, entry, {
              url: new URL(localizedPath(path, locale, defaultLocale), origin).href,
              params,
            }),
          { buildId },
        ),
      );
      // `enumeratePrerender` answers `[]` for a dynamic route with no `prerender()`, so a
      // `render: 'static'` route with a param writes nothing and used to be reported NOWHERE — past
      // the skip branch by its mode, absent from `pages` by its zero artifacts. A route in neither
      // list is the defect this report exists to close, wearing its other shape.
      if (artifacts.length === 0) {
        skipped.push(skippedRoute(facts, 'no-prerender-paths'));
        continue;
      }
      // One stats row per ROUTE, holding its heaviest page. `checkBudgets` looks a route up by
      // `route.url`, which is the manifest's DECLARED pattern (`/blog/:slug`), and this pushed the
      // FILLED path (`/blog/hello`) — so no dynamic static route has ever been weighed: every one
      // was `X_BUDGET_UNMEASURED` and `X_BUDGET_EXCEEDED` could not fire for the whole class. The
      // heaviest page and not the first, because a budget is a ceiling: the page that breaks it is
      // the one the route has to answer for. `pages` below still names every filled path.
      let heaviest: RouteStats | undefined;
      for (const artifact of artifacts) {
        const file = join(options.out, artifact.outputPath);
        const bytes = await Bun.write(file, artifact.html);
        pages.push({
          route: entry.path,
          path: artifact.path,
          locale: artifact.locale,
          file: artifact.outputPath,
          hash: artifact.hash,
          bytes,
        });
        // `artifact.hash` is `contentHash(html)` — the same identity that becomes this page's ETag,
        // so the precache revision and the HTTP validator can never disagree about one document.
        // Keyed by the FILLED path, which for a non-dynamic route is the declared one; a dynamic
        // route is not precached as a single URL anyway (`buildPrecacheManifest` skips it).
        // Measured from the document that was just written, so the `budgets` step compares a
        // declared budget against bytes that exist on disk rather than against a graph's estimate.
        const measured = await measureDocumentJs(artifact.html, options.out);
        // `assets` too: the chunks this page names are the ones the worker precaches with it.
        documents.set(artifact.path, {
          revision: artifact.hash,
          bytes,
          assets: measured.entries.map((entry) => entry.url),
        });
        const chain = heaviestSource(islands, measured.entries);
        if (heaviest !== undefined && heaviest.jsBytes >= measured.jsBytes) continue;
        heaviest = {
          path: entry.path,
          jsBytes: measured.jsBytes,
          frameworkJsBytes: measured.frameworkBytes,
          ...(chain === undefined ? {} : { heaviestChain: chain }),
        };
      }
      if (heaviest !== undefined) routes.push(heaviest);
    }
  } finally {
    await database.close();
  }
  // The worker, LAST: every document it precaches has now been rendered, hashed and weighed. A
  // static host runs no route table, so both files go into the artifact — a
  // `<script src="/x-sw-register.js">` in every document is a 404 otherwise, which is the same
  // promise `favicon.ico` and the icons above keep.
  const serviceWorker =
    pwa === undefined
      ? undefined
      : serviceWorkerArtifacts({
          pwa,
          buildId,
          routes: describeRoutes(),
          islands,
          styles,
          documents,
        });
  // `sw.js` only: `serviceWorker.register` IS `serviceWorkerRegistration()`, already on disk above
  // and identical by construction. A second writer of one path is how the two could ever disagree.
  if (serviceWorker !== undefined) {
    await Bun.write(join(options.out, SERVICE_WORKER_PATH.slice(1)), serviceWorker.source);
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
    // The list `X_BUDGET_UNMEASURED`'s `fix:` cites by name. It rode home on the in-process
    // `PrerenderReport` and nowhere else, and `cmd-build.ts` discards a successful subprocess's
    // stdout — so the one command the finding tells an author to run printed no `unmeasured` key
    // and no reason. Written into the report is what makes the instruction true.
    unmeasured,
    serviceWorkerWarnings: serviceWorker?.warnings ?? [],
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
    styles: styles.chunks.map((chunk) => chunk.url),
    serviceWorkerWarnings: serviceWorker?.warnings ?? [],
    warnings,
    origin,
  };
}
