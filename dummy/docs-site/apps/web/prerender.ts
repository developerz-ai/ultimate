// The static entry. `x build --target static` runs this with `--out <dir>` and it writes one HTML
// file per `render: 'static'` route — a CDN or an object store then serves site/ with no process
// behind it. Every other render mode needs a running app and is reported as skipped, never emitted.
//
// Skipped is not unweighed: a route that declares a `budget:` is rendered in memory and measured
// whatever its mode, so `x verify`'s `budgets` step has a number for it. `unmeasured` is the list
// this build could not render — each one is an X_BUDGET_UNMEASURED at the gate, and this is where
// the reason is.
//
// It writes the whole of `pages` and `skipped`, never a COUNT of either. A count is what let a
// partial artifact read as a complete one: someone pointed a screenshot tool at `.x/static` and
// filed "the island did not mount" against a route that had never been emitted (issue #242). Each
// skipped route carries its own `reason` and `why`, and `report` is where the same inventory
// landed on disk — which is what `x build --target static --json` reads back.

import { join } from 'node:path';
import { codeMarkdown, pieceMarkdown, searchEntries, siblingPath } from '@docs-site/docs-source';
import {
  loadSiteSettings,
  type PrerenderReport,
  prerenderSite,
  siteSeo,
  writeSiteSeo,
} from '@ultimat3/cli';
import { docsCorpus } from './shared/docs';
import { SEARCH_INDEX_PATH } from './shared/docs-links';
import { encodeIndex } from './site/search/search-index';

const root = join(import.meta.dir, '..', '..');
const flag = Bun.argv.indexOf('--out');
const out = (flag === -1 ? undefined : Bun.argv[flag + 1]) ?? join(root, '.x', 'static');
// SITE_ORIGIN is what canonical and og:url are built from; the default is only ever a local build.
// Property access, not `Bun.env['SITE_ORIGIN']`: the scaffolded tsconfig does not set
// `noPropertyAccessFromIndexSignature`, so the bracket form is the one biome's useLiteralKeys
// reports — a diagnostic in an app's first lint run over a file the app never wrote.
const origin = Bun.env.SITE_ORIGIN;

/**
 * `sitemap.xml` and `robots.txt`, into the same directory the HTML went: a static export is
 * served with no process behind it, so the CDN needs the files. `siteSeo` is the same answer a
 * running web role serves at `/sitemap.xml` and `/robots.txt` — the public `site/` routes, a
 * page whose `meta` says `robots: { index: false }` left out — so a crawler reads one sitemap
 * from the CDN and from the container.
 *
 * A DYNAMIC route contributes exactly the URLs this build emitted for it, read back off the report:
 * the sitemap then cannot name a page the artifact does not contain. What each page says of itself —
 * its `lastmod`, the `locales` it is listed in — is `report.entries`: the build's own `prerender()`
 * answers, so no route's `prerender()` runs twice in one build.
 *
 * With `seo.sitemap.sections` the answer is an index and its parts: `/sitemap.xml` plus
 * `/sitemaps/<name>-<n>.xml`, every one written here.
 *
 * `robots.txt` fails closed — anything that is not `ULTIMATE_ENV=production` emits
 * `Disallow: /` and advertises no sitemap — so a preview build cannot outrank the real site.
 */
async function writeSeoFiles(report: PrerenderReport): Promise<readonly string[]> {
  // The same crawler rules and sitemap settings the running server answers with
  // (app.config.ts seo.robots.disallow, seo.robots.groups and seo.sitemap).
  const settings = await loadSiteSettings(root);
  const seo = await siteSeo({
    // The origin the pages were built against, so the sitemap and every canonical agree.
    baseUrl: report.origin,
    disallow: settings.disallow,
    robotsGroups: settings.robotsGroups,
    sitemap: settings.sitemap,
    llms: settings.llms,
    root,
    pagesFor: (route) =>
      report.pages.filter((page) => page.route === route).map((page) => page.path),
    entries: report.entries,
    llmsPages: report.llmsPages,
  });
  return await writeSiteSeo(out, seo);
}

/**
 * The two kinds of file a docs site serves beside its HTML, from the same corpus the pages
 * rendered: `<page>.md`, every page as the markdown an agent reads without parsing HTML, and the
 * search index the `/search` island fetches. Written here, never by a route: neither is a document.
 */
async function writeDocsFiles(): Promise<readonly string[]> {
  const corpus = await docsCorpus();
  const files = new Map<string, string>([
    ...[...corpus.pages, ...corpus.majors].map((piece): [string, string] => [
      siblingPath(piece.url),
      pieceMarkdown(piece),
    ]),
    ...corpus.codes.map((piece): [string, string] => [siblingPath(piece.url), codeMarkdown(piece)]),
    [SEARCH_INDEX_PATH.slice(1), encodeIndex(searchEntries(corpus))],
  ]);
  for (const [path, text] of files) await Bun.write(join(out, path), text);
  return [...files.keys()];
}

if (import.meta.main) {
  const report = await prerenderSite({ root, out, ...(origin === undefined ? {} : { origin }) });
  const seo = await writeSeoFiles(report);
  const docs = await writeDocsFiles();
  await Bun.stdout.write(
    `${JSON.stringify({ ok: true, out: report.out, emitted: report.pages, skipped: report.skipped, unmeasured: report.unmeasured, report: report.report, seo, docs: docs.length })}\n`,
  );
}
