// The static build, against the real route registry: `renderStatic` is what enumerates and hashes,
// so a fixture that faked a route entry would prove nothing about what lands on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { useContext } from '@ultimat3/core';
import { clearRoutes, defineRoute, island, registerRoute, routeEntries } from '@ultimat3/render';
import { appManifest } from './app-manifest';
import { checkBudgets, readBuildStats } from './budgets';
import { faviconBytes } from './favicon';
import { isPrerenderable, prerenderSite } from './prerender';
import { readStaticReport } from './static-report';

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
    expect(report.skipped.map((route) => route.route)).toEqual(['/dashboard']);
    // A stream route on disk would be a shell nothing can ever fill — the file must not exist.
    expect(await Bun.file(join(out, 'dashboard/index.html')).exists()).toBe(false);
  });

  // A static export is served with no process behind it, so every byte the browser asks for has to
  // be IN the artifact — the same rule the island chunks above follow. Without it the export 404s
  // on the one request every browser makes unprompted.
  test('the export carries a favicon, so the served surfaces and the artifact agree', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    const written = await Bun.file(join(out, 'favicon.ico')).bytes();
    // Both sides re-wrapped: `Bun.file().bytes()` answers `Uint8Array<ArrayBuffer>` and
    // `faviconBytes` answers `Uint8Array<ArrayBufferLike>`, which is a different type argument and
    // no `toEqual` overload — the bytes are what this asserts, never the buffer they sit on.
    expect(new Uint8Array(written)).toEqual(new Uint8Array((await faviconBytes(ROOT)).bytes));
    expect(written.length).toBeGreaterThan(0);
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

  // `X_BUDGET_UNMEASURED` was unclosable by any invocation for these routes: only `static` was ever
  // rendered, so a `budget:` on ssr/isr/stream/spa produced no `build-stats.json` entry however the
  // build was run. Prerendering and MEASURING are two questions — the first decides what lands on
  // a CDN, the second weighs what a browser executes, and every mode makes the second promise.
  test('a budget on a non-static route is measured, and the page is still not written', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: streamRoute,
      suspenseBoundaries: 1,
    });
    const out = join(ROOT, 'static');
    const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    // Unchanged: a mode whose staleness nothing can correct never lands on disk.
    expect(report.pages.map((page) => page.file)).toEqual(['index.html']);
    expect(report.skipped.map((route) => route.route)).toEqual(['/dashboard']);
    expect(await Bun.file(join(out, 'dashboard/index.html')).exists()).toBe(false);

    const stats = await readBuildStats(ROOT);
    expect((stats?.routes ?? []).map((route) => route.path).sort()).toEqual(['/', '/dashboard']);
    const { manifest } = await appManifest(ROOT);
    expect(checkBudgets(manifest, stats ?? { routes: [] })).toEqual([]);
  });

  test('a route whose render throws is reported unmeasured, never silently skipped', async () => {
    registerRoute({
      file: 'apps/web/app/broken/page.tsx',
      config: defineRoute({
        render: 'ssr',
        hydrate: 'visible',
        offline: 'runtime',
        budget: { js: '10kb' },
        meta: () => ({ title: 'Broken', description: 'throws while rendering' }),
      }),
      component: () => {
        throw new TypeError('needs a request');
      },
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    expect(report.unmeasured.map((entry) => entry.path)).toEqual(['/broken']);
    expect(report.unmeasured[0]?.reason).toContain('needs a request');
    // On the FILE, not only on the in-process report. `X_BUDGET_UNMEASURED`'s `fix:` sends its
    // reader to `x build --target static --json`, which spawns `prerender.ts` as a subprocess and
    // reads this file back — so a list that lives only on the returned object reaches no reader at
    // all: `cmd-build.ts` discards a successful subprocess's stdout.
    const onDisk = await readStaticReport(ROOT);
    expect(onDisk?.unmeasured).toEqual(report.unmeasured);
    expect(onDisk?.unmeasured.map((entry) => entry.path)).toEqual(['/broken']);
    // And the budget it declared still fails the gate, because nothing weighed it.
    const { manifest } = await appManifest(ROOT);
    const findings = checkBudgets(manifest, (await readBuildStats(ROOT)) ?? { routes: [] });
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_UNMEASURED']);
  });

  test('an app with no static route writes nothing and says so, rather than failing', async () => {
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: streamRoute,
      suspenseBoundaries: 1,
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    expect(report.pages).toEqual([]);
    expect(report.skipped.map((route) => route.route)).toEqual(['/dashboard']);
  });
});

// #242: `.x/static/` held a partial site and said nothing about the difference. A screenshot tool
// was pointed at it, photographed the landing page and filed "the island did not mount" against a
// route that had never been in the artifact. Every declared route is now in exactly one of two
// lists, and the skipped ones carry the cause an author can act on.

/** `site/` + `isr`: prerenderable BY SURFACE, skipped by mode — the other half of the distinction. */
const isrRoute = defineRoute({
  render: 'isr',
  hydrate: 'never',
  offline: 'runtime',
  revalidate: { tags: [{ entity: 'blog' }] },
  budget: { js: '0kb' },
  meta: () => ({ title: 'Blog', description: 'regenerates' }),
});

/** `render: 'static'` with a dynamic param and no `prerender()` — enumerates nothing. */
const dynamicStaticRoute = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb' },
  meta: () => ({ title: 'Post', description: 'one per slug' }),
});

describe('the static build says what it emitted and what it did not', () => {
  test('every declared route lands in exactly one of emitted and skipped', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
    registerRoute({ file: 'apps/web/site/blog/page.tsx', config: isrRoute });
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: streamRoute,
      suspenseBoundaries: 1,
    });
    registerRoute({ file: 'apps/web/site/posts/[id]/page.tsx', config: dynamicStaticRoute });

    const declared = routeEntries().map((entry) => entry.path);
    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    const report = await readStaticReport(ROOT);
    expect(report?.target).toBe('static');
    const emitted = new Set((report?.emitted ?? []).map((page) => page.route));
    const skipped = new Set((report?.skipped ?? []).map((route) => route.route));

    // A route in NEITHER list is the original defect wearing a new shape. `/posts/:id` is the one
    // that used to vanish: `render: 'static'` put it past the skip branch, and `enumeratePrerender`
    // answered `[]`, so it wrote no file and was reported nowhere.
    for (const path of declared) {
      // Exactly one — in both is a double count, in NEITHER is the defect.
      expect(`${path}: ${Number(emitted.has(path)) + Number(skipped.has(path))}`).toBe(
        `${path}: 1`,
      );
    }
    expect([...emitted].sort()).toEqual(['/']);
    expect([...skipped].sort()).toEqual(['/blog', '/dashboard', '/posts/:id']);
  });

  test('the reason names the actual cause, and app/ does not borrow site/ ssr’s', async () => {
    registerRoute({ file: 'apps/web/site/blog/page.tsx', config: isrRoute });
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: streamRoute,
      suspenseBoundaries: 1,
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    const by = new Map(report.skipped.map((route) => [route.route, route]));

    // `app/` allows only stream|ssr, so the SURFACE is the cause and no `render:` edit helps.
    expect(by.get('/dashboard')?.reason).toBe('surface-forbids-static');
    expect(by.get('/dashboard')?.why).toContain('app/');
    expect(by.get('/dashboard')?.why).not.toContain("change it to render: 'static'");

    // `site/` + isr is a different cause with a different edit, and a flat reason string that
    // collapsed the two is what produces the next false bug report.
    expect(by.get('/blog')?.reason).toBe('mode-revalidates');
    expect(by.get('/blog')?.why).toContain("change it to render: 'static'");
    expect(by.get('/blog')?.why).not.toBe(by.get('/dashboard')?.why);
  });

  test('the emitted rows carry the file on disk, so the artifact can be checked against them', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
    const out = join(ROOT, 'static');
    const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    const onDisk = await readStaticReport(ROOT);
    expect(onDisk?.emitted).toEqual([{ route: '/', path: '/', file: 'index.html' }]);
    expect(onDisk?.out).toBe(out);
    // The written file is the one the row names — the check the screenshot tool could not make.
    for (const page of onDisk?.emitted ?? []) {
      expect(await Bun.file(join(out, page.file)).exists()).toBe(true);
    }
    expect(report.report).toBe(join(ROOT, '.x', 'static-report.json'));
  });
});

// The island half, end to end: the CLI is the only thing that can prove it, because the property
// under test is what the BUILD emitted — one chunk per island, booted by the document, and charged
// to the route that boots it. `renderStatic` and the collector are already pinned in
// `@ultimat3/render`; nothing there can see a file on disk.

/** A real client entry: no JSX, so the assertion is about bundling and not about a JSX runtime. */
const COUNTER_ISLAND = `
export function mount(el: HTMLElement, props: { readonly start: number }): void {
  el.textContent = String(props.start);
}
`;

/** Same module, padded past the route's budget — the bytes are the point, so they are literal. */
const HEAVY_ISLAND = `
const PAYLOAD = '${'x'.repeat(4096)}';
export function mount(el: HTMLElement): void {
  el.textContent = PAYLOAD;
}
`;

const Counter = island({ src: './counter.island.tsx', props: ['start'] });
const Heavy = island({ src: './heavy.island.tsx' });

const CounterPage = (): unknown => Counter({ start: 3, children: '0' });
const HeavyPage = (): unknown => Heavy({ children: 'loading' });

const islandRoute = defineRoute({
  render: 'static',
  hydrate: 'idle',
  offline: 'precache',
  budget: { js: '20kb' },
  meta: () => ({ title: 'Counter', description: 'one island' }),
});

const tightRoute = defineRoute({
  render: 'static',
  hydrate: 'idle',
  offline: 'precache',
  budget: { js: '1kb' },
  meta: () => ({ title: 'Heavy', description: 'one island, over budget' }),
});

describe('x build --target static, with islands', () => {
  test('the document boots exactly one chunk, and the page next door still ships no JS', async () => {
    await Bun.write(join(ROOT, 'apps/web/site/counter/counter.island.tsx'), COUNTER_ISLAND);
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
    registerRoute({
      file: 'apps/web/site/counter/page.tsx',
      config: islandRoute,
      component: CounterPage,
    });

    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    const html = await Bun.file(join(out, 'counter/index.html')).text();
    const entries = [...html.matchAll(/data-x-entry="(?<url>[^"]+)"/g)];
    // Exactly one: the island is its own entry point, so the page boots its chunk and nothing else.
    expect(entries).toHaveLength(1);
    const url = entries[0]?.groups?.['url'] ?? '';
    expect(url).toMatch(/^\/islands\/counter-[0-9a-f]{8}\.js$/);

    const chunk = Bun.file(join(out, url.slice(1)));
    expect(await chunk.exists()).toBe(true);
    expect(await chunk.text()).toContain('textContent');

    // The runtime is emitted, once, and inside the body it hydrates.
    expect(html).toContain('data-x-hydrate="idle"');
    expect(html).toContain('requestIdleCallback');
    expect(html.indexOf('requestIdleCallback')).toBeLessThan(html.indexOf('</body>'));

    // Axiom 6: the static page beside it renders through the same assembler and pays nothing.
    expect(await Bun.file(join(out, 'index.html')).text()).not.toContain('<script');

    const stats = await readBuildStats(ROOT);
    const measured = new Map((stats?.routes ?? []).map((route) => [route.path, route]));
    expect(measured.get('/')?.jsBytes).toBe(0);
    expect(measured.get('/counter')?.jsBytes).toBeGreaterThanOrEqual(chunk.size);
  });

  test('an island over the route budget trips X_BUDGET_EXCEEDED naming the island file', async () => {
    await Bun.write(join(ROOT, 'apps/web/site/heavy/heavy.island.tsx'), HEAVY_ISLAND);
    registerRoute({
      file: 'apps/web/site/heavy/page.tsx',
      config: tightRoute,
      component: HeavyPage,
    });

    await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    const { manifest } = await appManifest(ROOT);
    const findings = checkBudgets(manifest, (await readBuildStats(ROOT)) ?? { routes: [] });

    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_EXCEEDED']);
    // Naming the island is the whole point: "your bundle got bigger" is not an instruction.
    expect(findings[0]?.cause).toContain('apps/web/site/heavy/heavy.island.tsx');
  });
});

/**
 * The build measures a budget by RENDERING the route, through the same `routeDocument` a request
 * takes — and a request arrives inside `runWithContext`, installed by the HTTP pipeline
 * (`dev-render.ts`). `prerenderSite` called it bare, so every route whose component, `load` or
 * `meta` reads `useContext()` threw `X_NO_CONTEXT` and was filed as unmeasured. Measured against
 * `examples/dummy`: `/posts/new` and `/settings` both, for that reason alone.
 */
describe('the budget render runs inside a request context, exactly as a served render does', () => {
  const contextReading = (title: string) =>
    defineRoute({
      render: 'ssr',
      hydrate: 'visible',
      offline: 'runtime',
      budget: { js: '10kb' },
      meta: () => ({ title, description: 'reads the ambient request context' }),
    });

  test('a component that reads useContext() is weighed, not filed as unmeasured', async () => {
    registerRoute({
      file: 'apps/web/app/settings/page.tsx',
      config: contextReading('Settings'),
      // The one line the served path makes work and the build did not.
      component: () => `<p>${useContext().role}</p>`,
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    expect(report.unmeasured).toEqual([]);
    expect((await readBuildStats(ROOT))?.routes.map((route) => route.path)).toEqual(['/settings']);
  });

  test('the context it runs under is the web role and this build`s id', async () => {
    const seen: string[] = [];
    registerRoute({
      file: 'apps/web/app/probe/page.tsx',
      config: contextReading('Probe'),
      component: () => {
        const ctx = useContext();
        seen.push(`${ctx.role}:${ctx.buildId}`);
        return '<p>ok</p>';
      },
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    expect(report.unmeasured).toEqual([]);
    expect(seen).toEqual([`web:${report.buildId}`]);
  });

  // The other call site, and it had the same hole: a `render: 'static'` route reaches
  // `renderStatic`, whose page callback is this same `routeDocument`.
  test('a prerendered static route reads it too', async () => {
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config: defineRoute({
        render: 'static',
        hydrate: 'never',
        offline: 'precache',
        meta: () => ({ title: 'Home', description: 'the landing page a crawler reads' }),
      }),
      component: () => `<p>${useContext().role}</p>`,
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    expect(report.pages.map((page) => page.path)).toEqual(['/']);
    expect(report.skipped).toEqual([]);
  });
});
