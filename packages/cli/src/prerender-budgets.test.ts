// The static build's BUDGET-ACCOUNTING half, split from `prerender.test.ts` at the 500-line
// ceiling. Same fixture root, same registry discipline: every case runs the real build and reads
// what it wrote to `.x/build-stats.json`.
//
// One subject: the framework's own injected runtime is not the app's JavaScript, and the number
// the build records for it must be a property of the BUILD rather than of what happened to be
// left in the output directory. Both halves need a real `prerenderSite`, because the defect lives
// in the ORDER two file operations happen in and no fixture can fake an order.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, island, registerRoute, themeScriptBody } from '@ultimat3/render';
import { readBuildStats } from './budgets';
import { isRuntimeChunk } from './island-runtime';
import { prerenderSite } from './prerender';
import { processRoot } from './process-root-fixture';
import { serviceWorkerRegistration } from './sw-artifacts';

// Its own directory: `prerender.test.ts` and `prerender-islands.test.ts` wrote the SAME root, and
// under the gate's parallel workers each file's build read the other's `app.config.ts` and output.
const ROOT = processRoot(join(import.meta.dir, '..', '.prerender-budgets-fixture'));

// `defineRoute`, not a literal: the registry refuses a raw declaration, and this is the exact
// config `x new` writes for `site/page.tsx` — `js: '0kb'` included, which is the promise under test.
const staticRoute = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb' },
  meta: () => ({ title: 'Home', description: 'the landing page' }),
});

/**
 * The smallest installable app: `loadPwaArtifacts` reads this file structurally, so it needs the
 * `enabled` switch, a name, both colour pairs and the fallback — and nothing else. The fallback is
 * what makes `serviceWorkerHead` emit the registration tag, which is the whole subject here.
 */
const pwaConfig = (): string =>
  "export const config = { name: 'fixture', pwa: { enabled: true, name: 'Fixture'," +
  " offline: { fallback: '/offline' }," +
  " colors: { light: { themeColor: '#fff', backgroundColor: '#fff' }," +
  " dark: { themeColor: '#000', backgroundColor: '#000' } } } };\n";

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'prerender-fixture', version: '1.0.0' }),
  );
});

afterEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// `frameworkJsBytes` is the framework's own injected runtime, reported per route so a reader is
// owed the number `budget.js` no longer charges. It was measured off `/x-sw-register.js` ON DISK
// while that file was still written LAST, beside `sw.js` — which is the run-order defect the
// `jsBytes` split had just removed, alive again one field over: 0 on a clean output directory
// because the file did not exist when it was weighed, and the PREVIOUS build's copy on a reused
// one. Both cases are below, because a fix that closes one and not the other is the same bug with
// a narrower window.
//
// The repair is the order, not the reader: the registration is two constants and a string, so it
// is on disk before the first render. `sw.js` still comes last — its precache manifest is built
// from the rendered documents' content hashes, which is a real dependency.
// ---------------------------------------------------------------------------------------------
describe('x build --target static · the framework`s bytes are counted, never charged', () => {
  // Two framework scripts on every document: the service-worker registration (a `<script src>`)
  // and the inlined theme boot (`pwaConfig()` declares no `theme.defaultMode`, so `'system'`).
  // Both are counted in `frameworkJsBytes` and neither is charged to the route.
  const REGISTRATION_BYTES =
    Buffer.byteLength(serviceWorkerRegistration(), 'utf8') +
    Buffer.byteLength(themeScriptBody({ fallback: 'system' }), 'utf8');

  test('the registration has bytes at all, or both assertions below are vacuous', () => {
    expect(REGISTRATION_BYTES).toBeGreaterThan(0);
  });

  test('frameworkJsBytes is the registration`s real size on a CLEAN output directory', async () => {
    await Bun.write(join(ROOT, 'app.config.ts'), pwaConfig());
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });

    const out = join(ROOT, 'static');
    expect(await Bun.file(join(out, 'x-sw-register.js')).exists()).toBe(false);
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    const stats = await readBuildStats(ROOT);
    const home = stats?.routes.find((route) => route.path === '/');
    // The app ships none of its own, which is what makes the framework's number the whole story.
    expect(home?.jsBytes).toBe(0);
    expect(home?.frameworkJsBytes).toBe(REGISTRATION_BYTES);
  });

  test('and a REUSED output directory records the same number, not the last build`s file', async () => {
    await Bun.write(join(ROOT, 'app.config.ts'), pwaConfig());
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });

    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    const first = (await readBuildStats(ROOT))?.routes.find((route) => route.path === '/');
    // Second pass over the SAME directory, exactly as `bin/check` run twice does. Nothing was
    // cleaned, so the previous `/x-sw-register.js` is sitting there.
    expect(await Bun.file(join(out, 'x-sw-register.js')).exists()).toBe(true);
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    const second = (await readBuildStats(ROOT))?.routes.find((route) => route.path === '/');

    expect(first?.frameworkJsBytes).toBe(REGISTRATION_BYTES);
    expect(second?.frameworkJsBytes).toBe(first?.frameworkJsBytes);
    // The verdict, which is the thing that flipped: the same commit gated the same way twice.
    expect(second?.jsBytes).toBe(first?.jsBytes);
  });
});

// ---------------------------------------------------------------------------------------------
// The breakdown `X_BUDGET_EXCEEDED` prints is only as good as the row the build wrote, and the
// build writes rows on TWO branches — a published `static` page and an `app/` page rendered only
// to weigh (the Windows job's `/posts`). Both go through `routeStatsRow`; this holds them to it,
// against the real chunk on disk, so the clause can never name a file or a byte count the
// artifact does not have.
// ---------------------------------------------------------------------------------------------
describe('x build --target static · each row names the files it charged', () => {
  const PLAIN_ISLAND = `
export function mount(el: HTMLElement): void {
  el.textContent = 'ready';
}
`;
  const Plain = island({ src: './plain.island.tsx' });

  test.each([
    ['a published static page', 'apps/web/site/plain/page.tsx', '/plain', 'static'],
    ['an app/ page rendered only to weigh', 'apps/web/app/plain/page.tsx', '/plain', 'ssr'],
  ] as const)(
    '%s: its chunk at its on-disk size, and the hydration runtime as inline bytes',
    async (_name, file, path, render) => {
      await Bun.write(join(ROOT, file.replace('page.tsx', 'plain.island.tsx')), PLAIN_ISLAND);
      registerRoute({
        file,
        config: defineRoute({
          render,
          hydrate: 'idle',
          offline: render === 'static' ? 'precache' : 'runtime',
          budget: { js: '20kb' },
          meta: () => ({ title: 'Plain', description: 'one island' }),
        }),
        component: (): unknown => Plain({ children: '…' }),
      });

      const out = join(ROOT, 'static');
      await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
      const row = (await readBuildStats(ROOT))?.routes.find((one) => one.path === path);

      const [charged] = row?.charged ?? [];
      expect(row?.charged).toHaveLength(1);
      expect(charged?.url).toMatch(/^\/islands\/plain-[0-9a-f]{8}\.js$/);
      expect(charged?.bytes).toBe(Bun.file(join(out, (charged?.url ?? '').slice(1))).size);
      // The runtime is the one inline script an island page carries, so the parts sum to the whole.
      expect(row?.inlineJsBytes).toBeGreaterThan(0);
      expect((charged?.bytes ?? 0) + (row?.inlineJsBytes ?? 0)).toBe(row?.jsBytes ?? -1);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// #505: a realtime island loads the page runtime from the page boot where the document carries one
// — a scoped app/ page as served — and from `/islands/page-runtime.<id>.js` everywhere else. The weigh
// branch rendered app/ pages UNSCOPED, so it charged `/feed` and `/runs` a runtime chunk no scoped
// page fetches and never the boot every one of them does. Both documents are below, end to end.
// ---------------------------------------------------------------------------------------------
describe('x build --target static · a realtime island is weighed as its document loads it', () => {
  const LIVE_ISLAND = `import { useConnection } from '@ultimat3/realtime';
export function mount(): void {
  useConnection();
}
`;
  const Live = island({ src: './live.island.tsx' });
  const route = (render: 'static' | 'stream') =>
    defineRoute({
      render,
      hydrate: 'idle',
      offline: render === 'static' ? 'precache' : 'runtime',
      budget: { js: '500kb' },
      meta: () => ({ title: 'Live', description: 'one realtime island' }),
    });

  test('a scoped app/ page: its page boot is charged, the runtime chunk is not', async () => {
    await Bun.write(join(ROOT, 'apps/web/app/live/live.island.tsx'), LIVE_ISLAND);
    registerRoute({
      file: 'apps/web/app/live/page.tsx',
      config: route('stream'),
      component: (): unknown => Live({ children: '…' }),
      // A stream is always scoped (`private, no-store`) — the mode that needs no policy to be.
      suspenseBoundaries: 1,
    });

    await prerenderSite({ root: ROOT, out: join(ROOT, 'static'), origin: 'https://example.test' });
    const row = (await readBuildStats(ROOT))?.routes.find((one) => one.path === '/live');
    const urls = (row?.charged ?? []).map((one) => one.url);

    expect(urls.some((url) => url.startsWith('/_x/assets/page-boot/'))).toBe(true);
    expect(urls.some((url) => url.startsWith('/islands/live-'))).toBe(true);
    expect(urls.some(isRuntimeChunk)).toBe(false);
  });

  test('a static export: no boot in the document, so the runtime chunk is charged', async () => {
    await Bun.write(join(ROOT, 'apps/web/site/live/live.island.tsx'), LIVE_ISLAND);
    registerRoute({
      file: 'apps/web/site/live/page.tsx',
      config: route('static'),
      component: (): unknown => Live({ children: '…' }),
    });

    await prerenderSite({ root: ROOT, out: join(ROOT, 'static'), origin: 'https://example.test' });
    const row = (await readBuildStats(ROOT))?.routes.find((one) => one.path === '/live');
    const urls = (row?.charged ?? []).map((one) => one.url);

    expect(urls.some(isRuntimeChunk)).toBe(true);
    expect(urls.some((url) => url.startsWith('/_x/assets/page-boot/'))).toBe(false);
  });
});
