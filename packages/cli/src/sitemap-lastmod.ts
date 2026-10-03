// A sitemap `<lastmod>` per route source file — `seo.sitemap.lastmod` in `app.config.ts`. Read once
// per file per process: the running web role answers `/sitemap.xml` per request, and a `git log`
// per route per request is a subprocess per crawler hit for a date that changes on deploy.

// why: Bun has no synchronous stat, and `Bun.file(missing).lastModified` answers a garbage date
// (measured: year 144683) instead of refusing — the sitemap is built synchronously per route.
import { statSync } from 'node:fs';
// why: Bun exposes no path-join primitive, and the route file is app-root-relative.
import { join } from 'node:path';
import type { SitemapLastmod } from '@ultimat3/core';

/** The moment this process first built a sitemap — `'build'`'s one timestamp for every URL. */
let builtAt: string | undefined;

const cache = new Map<string, string | undefined>();

/** One `git log -1` over one path; a synchronous wait past this blocks the request serving it. */
const GIT_DATE_TIMEOUT_MS = 5_000;

/**
 * The `<lastmod>` for one route file, W3C Datetime (ISO 8601, UTC), or `undefined` when the source
 * yields none — a sitemap entry without `<lastmod>` is valid, a wrong one misleads a crawler.
 *
 * `'git'` falls back to the file's mtime where there is no work tree (a container image): the
 * image's copy of the file was written by the build, which is the honest "last changed" there.
 */
export function lastmodOf(file: string, mode: SitemapLastmod, root: string): string | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'build') {
    builtAt ??= new Date().toISOString();
    return builtAt;
  }
  const key = `${mode}\u0000${root}\u0000${file}`;
  if (cache.has(key)) return cache.get(key);
  const value = (mode === 'git' ? gitDate(file, root) : undefined) ?? mtimeOf(join(root, file));
  cache.set(key, value);
  return value;
}

/** Test seam: forget every date read, so a test can move a file's clock. */
export function resetLastmodCache(): void {
  cache.clear();
  builtAt = undefined;
}

function gitDate(file: string, root: string): string | undefined {
  try {
    const run = Bun.spawnSync(['git', 'log', '-1', '--format=%cI', '--', file], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'ignore',
      // A wedged `git` (a lock, a credential prompt) answers no date: the mtime fallback below.
      timeout: GIT_DATE_TIMEOUT_MS,
    });
    if (run.exitCode !== 0) return undefined;
    return isoOf(run.stdout.toString().trim());
  } catch {
    // No `git` binary on PATH: the fallback, never a sitemap that cannot be served.
    return undefined;
  }
}

function mtimeOf(path: string): string | undefined {
  try {
    const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    return modified !== undefined && Number.isFinite(modified) && modified > 0
      ? new Date(modified).toISOString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isoOf(text: string): string | undefined {
  if (text === '') return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
