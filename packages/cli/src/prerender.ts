// `x build --target static` — the `site/` surface, rendered once and written as files a CDN or an
// object store can serve with no process behind it. Enumeration, hashing and the output path are
// `@ultimat3/render`'s `renderStatic`; the document is the one `x dev` serves. This file decides
// only which routes qualify and where the bytes land.

import { join } from 'node:path';
import type { RouteEntry } from '@ultimat3/render';
import { renderStatic, routeEntries } from '@ultimat3/render';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import type { RouteStats } from './budgets';
import { measureDocumentJs, writeBuildStats } from './budgets';
import { routeDocument } from './dev-render';
import type { IslandBundle } from './island-bundle';
import { buildIslands, writeIslands } from './island-bundle';

/**
 * `static` only. `isr` revalidates and `ssr`/`stream`/`spa` need a process, so writing any of them
 * to disk would publish a page whose staleness nothing can correct — and the route already
 * declared which of the five it is.
 */
export const isPrerenderable = (entry: RouteEntry): boolean => entry.config.render === 'static';

export interface PrerenderOptions {
  readonly root: string;
  readonly out: string;
  /** Origin the rendered `<head>` builds canonical and og:url from. */
  readonly origin?: string;
}

export interface PrerenderedPage {
  readonly path: string;
  /** Relative to `out`, POSIX, as `renderStatic` computed it. */
  readonly file: string;
  readonly hash: string;
  readonly bytes: number;
}

export interface PrerenderReport {
  readonly out: string;
  readonly buildId: string;
  readonly pages: readonly PrerenderedPage[];
  /** Routes that exist and are not static. Reported, so "only 2 pages" is never a mystery. */
  readonly skipped: readonly string[];
  /** Where the measured stats landed, for the `budgets` gate step to read. */
  readonly stats: string;
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

export async function prerenderSite(options: PrerenderOptions): Promise<PrerenderReport> {
  // The same load `x dev` and `x manifest` perform: importing the app's modules IS what fills the
  // route registry, so there is no route table to prerender before this runs.
  await loadApp(options.root);
  const buildId = (await appManifest(options.root)).manifest.buildId;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const pages: PrerenderedPage[] = [];
  const skipped: string[] = [];
  const routes: RouteStats[] = [];

  // Before the first document: a page's `data-x-entry` is a built chunk's URL, so the chunks have
  // to exist to be named. Written into `out` too — a static export is served with no process
  // behind it, so the artifact carries every byte the browser will ask for.
  const islands = await buildIslands(options.root);
  await writeIslands(islands, options.out);

  for (const entry of routeEntries()) {
    if (!isPrerenderable(entry)) {
      skipped.push(entry.path);
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
    for (const artifact of artifacts) {
      const file = join(options.out, artifact.outputPath);
      const bytes = await Bun.write(file, artifact.html);
      pages.push({ path: artifact.path, file: artifact.outputPath, hash: artifact.hash, bytes });
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
  return {
    out: options.out,
    buildId,
    pages,
    skipped,
    stats,
    islands: islands.chunks.map((chunk) => chunk.file),
  };
}
