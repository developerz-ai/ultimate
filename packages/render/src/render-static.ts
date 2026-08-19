/**
 * `static` — build-time render. Enumerates `prerender()`, renders each params set once,
 * content-hashes the output. The hash is the artifact's identity: it becomes the ETag,
 * the precache revision in `sw.js`, and the asset filename suffix.
 */

import { renderThrowable, useContext } from '@ultimat3/core';
import { PrerenderFailedError, RouteModeInvalidError } from './errors';
import type { RouteEntry } from './registry';
import type { RenderResult, RouteParams } from './route';

export interface StaticArtifact {
  readonly path: string;
  readonly params: RouteParams;
  readonly html: string;
  /** FNV-1a of the HTML. Stable across machines and across Bun versions. */
  readonly hash: string;
  /** Where the file lands on disk, relative to the build output root. */
  readonly outputPath: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type StaticRenderFn = (input: {
  readonly path: string;
  readonly params: RouteParams;
}) => string | Promise<string>;

/** Deterministic, dependency-free 32-bit FNV-1a, hex. */
export function contentHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
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

/** Normalize `prerender()` output. A bare string fills the route's one dynamic param. */
export async function enumeratePrerender(entry: RouteEntry): Promise<readonly RouteParams[]> {
  const prerender = entry.config.prerender;
  if (prerender === undefined) {
    return entry.pattern.keys.length === 0 ? [{}] : [];
  }

  let produced: readonly (string | RouteParams)[];
  try {
    produced = await prerender();
  } catch (error) {
    throw new PrerenderFailedError(
      // `renderThrowable`, never `.message`/`String()`: `prerender` is app code and may throw a
      // value whose read raises in turn — this frame is what makes the build failure a coded one.
      `prerender() for ${entry.path} threw: ${renderThrowable(error)}`,
      `fix prerender in ${entry.file} — it runs at build time with no request context`,
    );
  }

  if (!Array.isArray(produced)) {
    throw new PrerenderFailedError(
      `prerender() for ${entry.path} returned ${typeof produced}, expected an array`,
      `return an array of params from prerender in ${entry.file}`,
    );
  }

  const keys = entry.pattern.keys;
  return produced.map((item) => {
    if (typeof item !== 'string') return item;
    const only = keys[0];
    if (keys.length !== 1 || only === undefined) {
      throw new PrerenderFailedError(
        `prerender() for ${entry.path} returned the bare string ${JSON.stringify(item)} ` +
          `but the route has ${keys.length} dynamic params (${keys.join(', ')})`,
        `return objects from prerender in ${entry.file}, e.g. { ${keys.join(': …, ')}: … }`,
      );
    }
    return { [only]: item };
  });
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
    const path = fillPath(entry.pattern.source, params);
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
      outputPath: `${path === '/' ? '' : path}/${indexFile}`.replace(/^\/+/, ''),
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
    'x-ultimate-build': buildId,
  };
}

export function staticResult(artifact: StaticArtifact): RenderResult {
  return { status: 200, headers: artifact.headers, body: artifact.html };
}

/** `/blog/:slug` + `{ slug: 'hello' }` → `/blog/hello`. */
export function fillPath(pattern: string, params: RouteParams): string {
  return (
    pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) return params[segment.slice(1)] ?? segment;
        if (segment.startsWith('*')) return params[segment.slice(1)] ?? '';
        return segment;
      })
      .join('/')
      .replace(/\/+$/, '') || '/'
  );
}
