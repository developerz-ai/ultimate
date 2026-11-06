/**
 * e2e — the site as it is published: `x build --target static` into a throwaway directory, served
 * as files with no app process behind them (the GitHub Pages shape), and read by a real browser.
 * A code page answers 200 with its row's cause, a docs page runs no script of its own, and
 * `/search?q=X_DB_DRIFT` finds the code through the island and the static index.
 *
 * Skipped only on a machine with no Chrome; `E2E_BROWSER_REQUIRED=1` refuses the skip.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory, recursive-remove or path API; the build lands in a throwaway dir.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { E2eTab } from '@ultimat3/testing';
import {
  allowHost,
  DEFAULT_CDP_TIMEOUT_MS,
  E2E_BROWSER_CLOSE_MS,
  E2E_BROWSER_OPEN_MS,
  E2E_GOTO_MS,
  E2E_TAB_OPEN_MS,
  findChrome,
  openE2eBrowser,
} from '@ultimat3/testing';

/** The app root: `dummy/docs-site`, three directories above this file. */
const APP_ROOT = Bun.fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
/** The static build of 1,200-odd pages: ~30 s measured locally (2026-11-06), with room. */
const BUILD_MS = 180_000;

const noBrowser =
  (await findChrome(process.env)) === undefined && process.env['E2E_BROWSER_REQUIRED'] !== '1';

/** A file server and nothing else: a path is a file, or a directory's `index.html`. */
function serveFiles(dir: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path.includes('..')) return new Response(null, { status: 400 });
      // A path with an extension is a file (`/errors/X_A.md`); any other is a directory's page.
      const file = Bun.file(
        /\.[a-z]+$/.test(path) ? join(dir, path) : join(dir, path, 'index.html'),
      );
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(dir, '404.html')), { status: 404 });
    },
  });
}

describe.skipIf(noBrowser)('the published site, as files', () => {
  let out: string;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let browser: Awaited<ReturnType<typeof openE2eBrowser>>;
  let tab: E2eTab;

  beforeAll(
    async () => {
      out = await mkdtemp(join(tmpdir(), 'docs-site-e2e-'));
      const build = Bun.spawn(
        ['bunx', 'x', 'build', '--target', 'static', '--no-preflight', '--out', out, '--json'],
        { cwd: APP_ROOT, stdout: 'pipe', stderr: 'pipe', timeout: BUILD_MS },
      );
      const [code, text] = await Promise.all([build.exited, new Response(build.stdout).text()]);
      if (code !== 0)
        expect.unreachable(`x build --target static exited ${code}: ${text.slice(-2000)}`);
      server = serveFiles(out);
      base = `http://localhost:${server.port}`;
      allowHost(new URL(base).host);
      browser = await openE2eBrowser();
      tab = await browser.session.newTab();
    },
    BUILD_MS + E2E_BROWSER_OPEN_MS + E2E_TAB_OPEN_MS + DEFAULT_CDP_TIMEOUT_MS,
  );

  afterAll(async () => {
    await tab?.close();
    await browser?.close();
    server?.stop(true);
    if (out !== undefined) await rm(out, { recursive: true, force: true });
  }, E2E_BROWSER_CLOSE_MS + DEFAULT_CDP_TIMEOUT_MS);

  test('/errors/X_DB_DRIFT is 200 with its row, and its .md sibling is served', async () => {
    const page = await fetch(`${base}/errors/X_DB_DRIFT`, { signal: AbortSignal.timeout(5_000) });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('schema differs from migrations');
    expect(html).toContain('a column exists in code but in no migration');
    const md = await fetch(`${base}/errors/X_DB_DRIFT.md`, { signal: AbortSignal.timeout(5_000) });
    expect((await md.text()).startsWith('# X_DB_DRIFT')).toBe(true);
  });

  test(
    'a docs page loads no script of its own: 0 KB, observed',
    async () => {
      await tab.goto(`${base}/getting-started`);
      const sources = await tab.evaluate(
        `[...document.querySelectorAll('script[src], script[type="module"]')].map((el) => el.src ? new URL(el.src).pathname : 'inline module')`,
      );
      // The service worker's registration is the framework's, exempt from the budget by name.
      expect(sources).toEqual(['/x-sw-register.js']);
    },
    E2E_GOTO_MS + DEFAULT_CDP_TIMEOUT_MS,
  );

  test(
    '/search?q=X_DB_DRIFT lists the code page first, through the island',
    async () => {
      await tab.goto(`${base}/search?q=X_DB_DRIFT`);
      await tab.waitFor(
        `document.querySelector('[data-role="results"] a') !== null`,
        'the first search result',
        E2E_GOTO_MS,
      );
      expect(
        await tab.evaluate(
          `new URL(document.querySelector('[data-role="results"] a').href).pathname`,
        ),
      ).toBe('/errors/X_DB_DRIFT');
    },
    2 * E2E_GOTO_MS + DEFAULT_CDP_TIMEOUT_MS,
  );
});
