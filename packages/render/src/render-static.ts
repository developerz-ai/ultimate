/**
 * `static` — build-time render. Enumerates `prerender()`, renders each params set once,
 * content-hashes the output. The hash is the artifact's identity: it becomes the ETag,
 * the precache revision in `sw.js`, and the asset filename suffix.
 */

import { BUILD_ID_HEADER, renderThrowable, useContext } from '@ultimat3/core';
import { PrerenderFailedError, RouteModeInvalidError } from './errors';
import { enumeratePrerender } from './prerender-enumerate';
import type { RouteEntry } from './registry';
import type { RenderResult, RouteParams } from './route';
import { filePathOf, filledSegments, urlPathOf } from './static-path';

// Re-exported where it has always been imported from; the enumeration is `prerender-enumerate.ts`'s.
export { enumeratePrerender } from './prerender-enumerate';

export interface StaticArtifact {
  readonly path: string;
  readonly params: RouteParams;
  readonly html: string;
  /** `contentHash` (xxHash32) of the HTML. Stable across machines and across Bun versions. */
  readonly hash: string;
  /** Where the file lands on disk, relative to the build output root. */
  readonly outputPath: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type StaticRenderFn = (input: {
  readonly path: string;
  readonly params: RouteParams;
}) => string | Promise<string>;

/**
 * xxHash32 (seed 0) of the UTF-8 bytes, 8 hex characters. Native: FNV-1a in JS measured 134 µs on a
 * 96 kB document against 21 µs here, and every static page, ISR regeneration and CSS module hashes
 * through it. xxHash32 is a SPECIFIED algorithm — the test pins its reference vectors — so the value
 * is stable across machines and Bun versions, as the FNV one was. Switching was a one-time cache
 * bust: every ETag and every scoped CSS class name changed once, in 22.0.0. Bytes hash to what
 * their UTF-8 string does, so an icon's or an `asset()` file's ETag is this function too — the one
 * xxHash32 call in the framework (`bun run flight-copies` refuses a second).
 */
export function contentHash(input: string | Uint8Array): string {
  return Bun.hash.xxHash32(input).toString(16).padStart(8, '0');
}

/**
 * `static` must not observe the request. If a request-scoped context is live while a
 * static route renders, the output would depend on whoever triggered the build — a bug
 * that only shows up as one user's data cached for everyone.
 */
export function assertNoPerRequestState(file: string): void {
  let ctx: unknown;
  try {
    ctx = useContext();
  } catch {
    return; // no ambient context — the expected build-time situation
  }
  if (typeof ctx !== 'object' || ctx === null) return;
  if ('request' in ctx || 'actor' in ctx) {
    throw new RouteModeInvalidError(
      `${file} declares render: 'static' but rendered inside a request context ` +
        '(actor/request visible), so its output would leak per-request state',
      `change render to 'ssr' in ${file}, or move the request-dependent part into an island`,
    );
  }
}

export interface StaticBuildOptions {
  readonly buildId: string;
  /** Extension-less output files get `/index.html` appended. */
  readonly indexFile?: string;
}

export async function renderStatic(
  entry: RouteEntry,
  render: StaticRenderFn,
  options: StaticBuildOptions,
): Promise<readonly StaticArtifact[]> {
  assertNoPerRequestState(entry.file);
  const paramSets = await enumeratePrerender(entry);
  const indexFile = options.indexFile ?? 'index.html';

  const artifacts: StaticArtifact[] = [];
  for (const params of paramSets) {
    const segments = filledSegments(entry.pattern.source, params);
    const path = urlPathOf(segments);
    let html: string;
    try {
      html = await render({ path, params });
    } catch (error) {
      throw new PrerenderFailedError(
        `rendering ${path} failed: ${renderThrowable(error)}`,
        `x build --target static --json   # reproduces ${path}, then fix ${entry.file}`,
      );
    }
    const hash = contentHash(html);
    artifacts.push({
      path,
      params,
      html,
      hash,
      outputPath: filePathOf(segments, indexFile),
      headers: staticHeaders(hash, options.buildId),
    });
  }
  return artifacts;
}

export function staticHeaders(hash: string, buildId: string): Readonly<Record<string, string>> {
  return {
    'content-type': 'text/html; charset=utf-8',
    // Revalidate cheaply: the HTML URL is stable, its content hash is not.
    'cache-control': 'public, max-age=0, must-revalidate',
    etag: `"${hash}"`,
    [BUILD_ID_HEADER]: buildId,
  };
}

export function staticResult(artifact: StaticArtifact): RenderResult {
  return { status: 200, headers: artifact.headers, body: artifact.html };
}

/**
 * `/blog/:slug` + `{ slug: 'hello' }` → `/blog/hello`, each segment percent-encoded. A missing
 * param, a dot segment, a separator inside a `:param`, NUL, `?` and `#` are `X_PRERENDER_FAILED`
 * (`static-path.ts`) — they wrote a `:slug` directory, or a file outside the build output.
 */
export function fillPath(pattern: string, params: RouteParams): string {
  return urlPathOf(filledSegments(pattern, params));
}
