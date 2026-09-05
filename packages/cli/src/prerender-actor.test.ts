// WHO a measurement render runs as. What every authed page in a real app hit (2026-09-05): an
// `app/` page's `load` reads a policy-guarded query, the build rendered it as the ANONYMOUS actor,
// `can()` denied with X_UNAUTHENTICATED, and the route was X_BUDGET_UNMEASURED — so an app with a
// signed-in surface could not be green. Its own file, with its own fixture directory, because
// `prerender.test.ts` sits at the line ceiling and two files sharing one directory would race.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { useContext } from '@ultimat3/core';
import { can, definePermissions, knownPermissions, restorePermissions } from '@ultimat3/policy';
import { from, query, registerQueries, resetRegistry, runQuery, t } from '@ultimat3/query';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { readBuildStats } from './budgets';
import { MEASUREMENT_ACTOR_ID } from './measurement-actor';
import { prerenderSite } from './prerender';

const ROOT = join(import.meta.dir, '..', '.prerender-actor-fixture');

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
    JSON.stringify({ name: 'prerender-actor-fixture', version: '1.0.0' }),
  );
});

afterEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
});

describe('the actor a measurement render runs as', () => {
  // Weighing bytes needs no data authority; the rendered document is discarded.
  test('an app route whose load runs a policy-guarded query is measured, as the build actor', async () => {
    const before = knownPermissions();
    definePermissions(['thing:read']);
    try {
      const things = query({
        input: t.object({}),
        policy: can('thing:read'),
        sql: () => from<{ id: string }>('things', [{ id: 'a' }]),
      });
      registerQueries({ things });
      let renderedAs: string | undefined;
      registerRoute({ file: 'apps/web/site/page.tsx', config: staticRoute });
      registerRoute({
        file: 'apps/web/app/things/page.tsx',
        config: defineRoute({
          render: 'ssr',
          hydrate: 'visible',
          offline: 'runtime',
          policy: { permission: 'thing:read' },
          budget: { js: '60kb', lcp: 2500 },
          load: async () => {
            renderedAs = useContext().actor.id;
            return { rows: await runQuery(things, {}) };
          },
          meta: () => ({ title: 'Things', description: 'authed' }),
        }),
      });
      const out = join(ROOT, 'static');
      const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

      expect(report.unmeasured).toEqual([]);
      expect(renderedAs).toBe(MEASUREMENT_ACTOR_ID);
      const stats = await readBuildStats(ROOT);
      expect((stats?.routes ?? []).map((route) => route.path).sort()).toEqual(['/', '/things']);
      // Still not written: measuring and prerendering are two questions, and this answered one.
      expect(await Bun.file(join(out, 'things/index.html')).exists()).toBe(false);
    } finally {
      resetRegistry();
      restorePermissions(before);
    }
  });

  // The other half of the same change, and the half that must never move: a `render: 'static'`
  // page lands on a CDN for everyone, so it renders as the anonymous actor and a load a policy
  // refuses fails the build — never renders another actor's rows into a published file.
  test('a static site route still renders as the anonymous actor', async () => {
    let renderedAs: string | undefined;
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config: defineRoute({
        render: 'static',
        hydrate: 'never',
        offline: 'precache',
        budget: { js: '0kb', lcp: 1500 },
        load: async () => {
          renderedAs = useContext().actor.kind;
          return {};
        },
        meta: () => ({ title: 'Home', description: 'public' }),
      }),
    });
    const out = join(ROOT, 'static');
    const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    expect(report.pages.map((page) => page.file)).toEqual(['index.html']);
    expect(renderedAs).toBe('anonymous');
  });
});
