// `x build --target static` — the `site/` surface, rendered once and written as files a CDN or an
// object store can serve with no process behind it. Enumeration, hashing and the output path are
// `@ultimat3/render`'s `renderStatic`; the document is the one `x dev` serves. This file decides
// only which routes qualify and where the bytes land.

import { join } from 'node:path';
import type { RouteEntry } from '@ultimat3/render';
import { renderStatic, routeEntries } from '@ultimat3/render';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { routeDocument } from './dev-render';

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

  for (const entry of routeEntries()) {
    if (!isPrerenderable(entry)) {
      skipped.push(entry.path);
      continue;
    }
    const artifacts = await renderStatic(
      entry,
      ({ path, params }) => routeDocument(entry, { url: new URL(path, origin).href, params }),
      { buildId },
    );
    for (const artifact of artifacts) {
      const file = join(options.out, artifact.outputPath);
      const bytes = await Bun.write(file, artifact.html);
      pages.push({ path: artifact.path, file: artifact.outputPath, hash: artifact.hash, bytes });
    }
  }
  return { out: options.out, buildId, pages, skipped };
}
