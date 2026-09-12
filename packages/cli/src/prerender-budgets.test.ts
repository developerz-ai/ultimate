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
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { readBuildStats } from './budgets';
import { prerenderSite } from './prerender';
import { serviceWorkerRegistration } from './sw-artifacts';

const ROOT = join(import.meta.dir, '..', '.prerender-fixture');

// `defineRoute`, not a literal: the registry refuses a raw declaration, and this is the exact
// config `x new` writes for `site/page.tsx` — `js: '0kb'` included, which is the promise under test.
const staticRoute = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb', lcp: 1500 },
  meta: () => ({ title: 'Home', description: 'the landing page' }),
});

/**
 * The smallest installable app: `loadPwaArtifacts` reads this file structurally, so it needs the
 * `enabled` switch, a name, both colour pairs and the fallback — and nothing else. The fallback is
 * what makes `serviceWorkerHead` emit the registration tag, which is the whole subject here.
 */
const pwaConfig = (): string =>
  "export const config = { pwa: { enabled: true, name: 'Fixture'," +
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
  const REGISTRATION_BYTES = Buffer.byteLength(serviceWorkerRegistration(), 'utf8');

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
