// The static build, against the real route registry: `renderStatic` is what enumerates and hashes,
// so a fixture that faked a route entry would prove nothing about what lands on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { clearRoutes, defineRoute, registerRoute, routeEntries } from '@ultimat3/render';
import { isPrerenderable, prerenderSite } from './prerender';

const ROOT = join(import.meta.dir, '..', '.prerender-fixture');

// `defineRoute`, not a literal: the registry refuses a raw declaration, and these are the exact
// configs `x new` writes for site/page.tsx and app/dashboard/page.tsx.
const staticRoute = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb', lcp: 1500 },
  meta: () => ({ title: 'Home', description: 'the landing page' }),
});

const streamRoute = defineRoute({
  render: 'stream',
  hydrate: 'visible',
  offline: 'runtime',
  policy: { permission: 'dashboard:read' },
  budget: { js: '60kb', lcp: 2500 },
  meta: () => ({ title: 'Dashboard', description: 'authed' }),
});

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

describe('x build --target static', () => {
  test('only render: static is written; every other mode is reported as skipped', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: streamRoute,
      suspenseBoundaries: 1,
    });
    expect(
      routeEntries()
        .filter(isPrerenderable)
        .map((entry) => entry.path),
    ).toEqual(['/']);

    const out = join(ROOT, 'static');
    const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    expect(report.pages.map((page) => page.file)).toEqual(['index.html']);
    expect(report.skipped).toEqual(['/dashboard']);
    // A stream route on disk would be a shell nothing can ever fill — the file must not exist.
    expect(await Bun.file(join(out, 'dashboard/index.html')).exists()).toBe(false);
  });

  test('the written file is the document the dev server serves, with the route metadata in it', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
    const out = join(ROOT, 'static');
    const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    const html = await Bun.file(join(out, 'index.html')).text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Home</title>');
    expect(html).toContain('<link rel="canonical" href="/">');
    const page = report.pages[0];
    expect(page?.bytes).toBe(html.length);
    // The hash is the artifact's identity — the ETag and the precache revision are the same value.
    expect(page?.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test('the route sees the build origin, so an absolute URL in meta() is not localhost', async () => {
    // A `meta` that builds an absolute URL is the only thing `origin` reaches, and a build that
    // fell back to the default would publish `https://localhost` into every page's metadata.
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config: defineRoute({
        render: 'static',
        hydrate: 'never',
        offline: 'precache',
        budget: { js: '0kb', lcp: 1500 },
        meta: (data) => ({ title: String(data['url']), description: 'echoes the build url' }),
      }),
    });
    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    expect(await Bun.file(join(out, 'index.html')).text()).toContain(
      '<title>https://example.test/</title>',
    );
  });

  test('an app with no static route writes nothing and says so, rather than failing', async () => {
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: streamRoute,
      suspenseBoundaries: 1,
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    expect(report.pages).toEqual([]);
    expect(report.skipped).toEqual(['/dashboard']);
  });
});
