// The static build's ISLAND half, split from `prerender.test.ts` at the 500-line ceiling. Same
// fixture root, same registry discipline: every case registers its routes and the build proves
// what landed on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, island, registerRoute } from '@ultimat3/render';
import { appManifest } from './app-manifest';
import { checkBudgets, readBuildStats } from './budgets';
import { prerenderSite } from './prerender';
import { readStaticReport } from './static-report';
import { VERIFY_STEPS } from './verify-checks';
import type { VerifyContext } from './verify-step';

/** The step reads only `root`; the runner is what a step that shells out would call. */
const VERIFY_CTX: VerifyContext = {
  root: '/nowhere',
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
};

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

/** An `app/` page with a declared island: `hydrate` derived, a budget derived — rendered to weigh. */
const Dispatch = island({ src: './dispatch.island.tsx', props: ['hostId', 'models'] });

/** Past the cap by a margin no fixture drift can close: one row is ~90 B, and the cap is 16 KiB. */
const CATALOG = Array.from({ length: 300 }, (_, i) => ({
  id: `provider/model-${i}`,
  label: `Model ${i}, a display name of ordinary length`,
  context: 200_000,
}));

const CatalogPage = (): unknown => Dispatch({ hostId: 'h1', models: CATALOG, children: '…' });

const catalogRoute = defineRoute({
  render: 'ssr',
  hydrate: 'idle',
  offline: 'runtime',
  meta: () => ({ title: 'Fleet', description: 'one island, over the props cap' }),
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

  test('an island handed props over the cap is X_ISLAND_PROPS_INVALID on the gate, naming the prop — not X_BUDGET_UNMEASURED', async () => {
    // Measured on ai-maxxing, 2026-09-05: a 34-row model catalog in an island's props took the
    // page down at RUNTIME with a 500. The page derives a budget from its island, so the build
    // renders it to weigh it — and that render is where the overflow is a VERIFY-time finding.
    // It used to be filed as `X_BUDGET_UNMEASURED`, whose fix is to run the build and read its
    // list; the list already held the sentence, so the step now reports it by its own code.
    await Bun.write(join(ROOT, 'apps/web/app/fleet/dispatch.island.tsx'), COUNTER_ISLAND);
    registerRoute({
      file: 'apps/web/app/fleet/page.tsx',
      config: catalogRoute,
      component: CatalogPage,
    });

    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static') });
    expect(report.unmeasured).toHaveLength(1);
    const entry = report.unmeasured[0];
    expect(entry?.path).toBe('/fleet');
    expect(entry?.code).toBe('X_ISLAND_PROPS_INVALID');
    expect(entry?.cause).toContain('the dispatch island in apps/web/app/fleet/page.tsx carries');
    expect(entry?.cause).toContain('props.models is');
    expect(entry?.fix).toContain('pass `models: []`');
    // On disk too, field for field — the step reads the file, not the in-process report.
    expect((await readStaticReport(ROOT))?.unmeasured).toEqual(report.unmeasured);

    const { manifest } = await appManifest(ROOT);
    const findings = checkBudgets(manifest, await readBuildStats(ROOT), report.unmeasured);
    expect(findings.map((finding) => finding.code)).toEqual(['X_ISLAND_PROPS_INVALID']);
    expect(findings[0]?.at).toBe('/fleet');
    expect(findings[0]?.cause).toBe(entry?.cause);
    expect(findings[0]?.fix).toBe(entry?.fix);
    // Without the report, the same route is the generic finding it always was: the promotion
    // reads the build's own sentence and never invents one.
    expect(checkBudgets(manifest, await readBuildStats(ROOT)).map((f) => f.code)).toEqual([
      'X_BUDGET_UNMEASURED',
    ]);

    // And the `budgets` step itself, off the files this build wrote.
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'budgets');
    await Bun.write(join(ROOT, 'app.config.ts'), 'export const config = {};\n');
    const outcome = await step?.run({ ...VERIFY_CTX, root: ROOT });
    expect(outcome?.ok).toBe(false);
    const own = outcome?.findings.filter((finding) => finding.at === '/fleet');
    expect(own?.map((finding) => finding.code)).toEqual(['X_ISLAND_PROPS_INVALID']);
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
