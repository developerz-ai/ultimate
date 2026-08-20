// What the SEO gate can and cannot see. The half worth pinning is the boundary: a `site/` route
// whose `<head>` is a function of request data is REPORTED as unreachable, never reported as
// missing metadata — a gate that turns "I could not look" into "you forgot a title" is worse than
// no gate, because the fix it hands the reader is for a defect that is not there.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RegisterRouteInput } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { validateMeta } from '@ultimat3/seo';
import { readSiteMeta } from './seo-meta';

type Ctx = { url: string; params: Record<string, string> };

interface Fixture {
  readonly file: string;
  /** `app/` refuses `static` — `SURFACE_SPECS` allows it stream | spa | ssr only. */
  readonly render?: 'static' | 'ssr';
  readonly title?: string;
  readonly description?: string;
  readonly load?: boolean;
  readonly throws?: boolean;
}

function register(fixture: Fixture): void {
  const input: RegisterRouteInput<Ctx> = {
    file: fixture.file,
    suspenseBoundaries: 0,
    config: defineRoute<Ctx>({
      render: fixture.render ?? 'static',
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      ...(fixture.load === true ? { load: (ctx: Ctx) => Promise.resolve(ctx) } : {}),
      meta: (data) => {
        if (fixture.throws === true) throw new TypeError(`meta blew up for ${data.url}`);
        return {
          ...(fixture.title === undefined ? {} : { title: fixture.title }),
          ...(fixture.description === undefined ? {} : { description: fixture.description }),
        };
      },
    }),
  };
  registerRoute(input);
}

// BOTH halves, and the `beforeEach` is the one that matters. `routeEntries()` is a PROCESS-global
// registry, so this file's subject is whatever the process happens to hold — and a `packages/render`
// suite that registers routes and never clears them made these assertions fail only when the two
// packages were run in one `bun test` invocation, which is not how the gate shards them. A file
// that reads a global registry starts from a known state; it does not inherit one.
beforeEach(() => {
  clearRoutes();
});

afterEach(() => {
  clearRoutes();
});

describe('unit · readSiteMeta', () => {
  test('resolves a static site/ route the same way a render would', async () => {
    register({ file: 'apps/web/site/pricing/page.tsx', title: 'Pricing', description: 'Plans.' });

    const scan = await readSiteMeta();

    expect(scan.unresolved).toEqual([]);
    expect(scan.findings).toEqual([]);
    expect(scan.records).toEqual([
      {
        path: '/pricing',
        file: 'apps/web/site/pricing/page.tsx',
        surface: 'site',
        render: 'static',
        meta: { title: 'Pricing', description: 'Plans.' },
      },
    ]);
  });

  test('a route that declares load is unreachable, NOT a route missing its metadata', async () => {
    // Running `load` would make `x verify` need a live database to answer a question about text,
    // and would run the app's own queries. The route is named and skipped instead.
    register({ file: 'apps/web/site/blog/page.tsx', load: true, title: 'Blog', description: 'd' });

    const scan = await readSiteMeta();

    expect(scan.records).toEqual([]);
    expect(scan.unresolved).toEqual([
      { path: '/blog', file: 'apps/web/site/blog/page.tsx', reason: 'declares-load' },
    ]);
    // The half that matters: `validateMeta` is never handed this route, so it never reports it.
    expect(validateMeta(scan.records).issues).toEqual([]);
  });

  test('a dynamic route is unreachable — it has no one URL to resolve meta against', async () => {
    register({ file: 'apps/web/site/u/[handle]/page.tsx', title: 't', description: 'd' });

    const scan = await readSiteMeta();

    expect(scan.unresolved).toEqual([
      { path: '/u/:handle', file: 'apps/web/site/u/[handle]/page.tsx', reason: 'dynamic' },
    ]);
    expect(scan.records).toEqual([]);
  });

  test('an app/ route is not SEO surface at all and is neither checked nor reported', async () => {
    register({
      file: 'apps/web/app/dashboard/page.tsx',
      render: 'ssr',
      title: 'D',
      description: 'd',
    });

    const scan = await readSiteMeta();

    expect(scan.records).toEqual([]);
    expect(scan.unresolved).toEqual([]);
  });

  test('a meta() that throws is a FINDING carrying the thrown code, not a skipped route', async () => {
    // A page whose `<head>` cannot be built is a page that cannot render. Reporting it as
    // unreachable would let a route that 500s in production pass the gate in silence.
    register({ file: 'apps/web/site/broken/page.tsx', throws: true });

    const scan = await readSiteMeta();

    expect(scan.records).toEqual([]);
    expect(scan.unresolved).toEqual([]);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]?.at).toBe('apps/web/site/broken/page.tsx');
    expect(scan.findings[0]?.cause).toContain('meta blew up');
  });

  test('the records it produces are what validateMeta reports against', async () => {
    register({ file: 'apps/web/site/page.tsx', description: 'Only a description.' });

    const report = validateMeta((await readSiteMeta()).records);

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(['X_SEO_META_MISSING']);
    expect(report.issues[0]?.file).toBe('apps/web/site/page.tsx');
  });
});
