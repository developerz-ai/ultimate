// The surface stylesheet table: the CSS a document on `site/` or `app/` carries, content-hashed
// and addressed as a FILE rather than inlined into every response. The island table's shape one
// asset over (`island-bundle.ts`), because the two answer the same question — "what does this
// document make the browser fetch, and can it keep it?" — and one mechanism is the whole point.
//
// Why it stopped being an inline `<style>`: measured against ai-maxxing on 2026-09-06, every
// `app/` document carried one 156,738-byte block — 1,336 rules from 406 module sources, byte
// identical across `/`, `/fleet`, `/fleet/[host]` and the session page — inside a response the
// pipeline sends `Cache-Control: private, no-store`. 92% of the dashboard document and 89% of the
// session document, re-sent and re-parsed on every navigation, cacheable by nothing.

// Bun ships no path API; `join` is the filesystem side of writing a chunk into a static export.
// why: Bun exposes no path API — nothing native joins a directory to a URL-shaped path.
import { join } from 'node:path';
import type { Surface } from '@ultimat3/render';
import { SURFACES } from '@ultimat3/render';
import { contentHash, stylesFor, stylesheetsRevision } from '@ultimat3/render/server';

/**
 * The surfaces a stylesheet is minted for. `api/` is dropped for `documentSurfaces`' reason — it
 * emits no document, so a file no `<link>` can ever name would be bytes in the export and an entry
 * in the precache manifest with no reader. `shared/` stays: `x shot --island` renders an island
 * that lives there, and `surfaceOf` answers `shared` for it.
 */
const STYLED_SURFACES: readonly Surface[] = SURFACES.filter((surface) => surface !== 'api');

/**
 * Where a surface stylesheet is served from, in `x dev`, in the container and in a static export.
 * Sits beside `ISLAND_BASE_PATH`, `ICON_BASE_PATH` and `MEDIA_BASE_PATH`, and outside the dev-only
 * `/_x` namespace for their reason: the URL is baked into documents a static export publishes, so
 * a dev-only path would be a page that renders in `x dev` and 404s on a CDN.
 */
export const STYLE_BASE_PATH = '/styles';

export interface StyleChunk {
  /**
   * Every surface whose documents link it, sorted. Usually one — `site/` and `app/` carry
   * different modules — but an app whose only CSS is its global layer produces one byte string for
   * all three, and shipping it three times would put three copies in the static export and three
   * entries in the precache manifest, which has a budget.
   */
  readonly surfaces: readonly Surface[];
  /** Immutable, content-addressed URL. What `<link rel="stylesheet">` carries. */
  readonly url: string;
  readonly css: string;
  readonly bytes: number;
}

export interface StyleBundle {
  readonly chunks: readonly StyleChunk[];
  /** The `href` a document on this surface links, or `undefined` when the surface has no CSS. */
  hrefFor(surface: Surface | null): string | undefined;
  /** The chunk a URL names — for serving it, and for writing it into a static export. */
  chunkAt(url: string): StyleChunk | undefined;
}

/**
 * `stylesFor(null)` and `stylesFor('shared')` select the same sheets by construction — a `null`
 * surface matches only the package sheets, which `'shared'` already carries — so the one chunk
 * answers both. `island-harness.ts` is the caller that can hold a `null`.
 */
const surfaceKey = (surface: Surface | null): Surface => surface ?? 'shared';

/**
 * Derived, never cached across a change: `stylesheetsRevision()` moves when a sheet's rules move,
 * and island CSS registers on every `buildIslands` — which `x dev` re-runs on every watcher tick.
 * Memoised on that revision rather than recomputed per request, because the derivation is a filter
 * over every registered sheet plus a hash of the ~150 kB it joins.
 */
let memo: { readonly revision: number; readonly bundle: StyleBundle } | undefined;

export function styleBundle(): StyleBundle {
  const revision = stylesheetsRevision();
  if (memo !== undefined && memo.revision === revision) return memo.bundle;
  const bundle = styleBundleOf(
    STYLED_SURFACES.map((surface) => ({ surface, css: stylesFor(surface) })).filter(
      (sheet) => sheet.css.length > 0,
    ),
  );
  memo = { revision, bundle };
  return bundle;
}

/**
 * Test seam, and the shape `islandBundle` has: a table built from what the caller supplies.
 *
 * The URL is the content hash and nothing else — no surface in the name — because a surface is not
 * a property of the BYTES. Two surfaces with identical CSS are one file, one precache entry and
 * one download, which is what the name would otherwise prevent. The same `contentHash` that stamps
 * an ETag, a precache revision and an island chunk: one identity for a byte string, not a fourth.
 */
export function styleBundleOf(
  sheets: readonly { readonly surface: Surface; readonly css: string }[],
): StyleBundle {
  const byCss = new Map<string, Surface[]>();
  for (const sheet of sheets) {
    const held = byCss.get(sheet.css);
    if (held === undefined) byCss.set(sheet.css, [sheet.surface]);
    else held.push(sheet.surface);
  }
  const chunks: readonly StyleChunk[] = [...byCss].map(([css, surfaces]) => ({
    surfaces: [...surfaces].sort(),
    url: `${STYLE_BASE_PATH}/${contentHash(css)}.css`,
    css,
    bytes: new TextEncoder().encode(css).byteLength,
  }));
  const bySurface = new Map(
    chunks.flatMap((chunk) => chunk.surfaces.map((surface) => [surface, chunk] as const)),
  );
  const byUrl = new Map(chunks.map((chunk) => [chunk.url, chunk]));
  return {
    chunks,
    hrefFor: (surface: Surface | null): string | undefined =>
      bySurface.get(surfaceKey(surface))?.url,
    chunkAt: (url: string): StyleChunk | undefined => byUrl.get(url),
  };
}

/** Write every surface stylesheet under a static export, at the URL the documents already carry. */
export async function writeStyles(bundle: StyleBundle, out: string): Promise<void> {
  for (const chunk of bundle.chunks) {
    await Bun.write(join(out, chunk.url.slice(1)), chunk.css);
  }
}
