// Which fetches a build's render answers in process. Only the app's own origin — the build's, or
// the `APP_URL` its typed client posts to — is the app's API: a page `load` that reads a CMS at
// build reached the app's pipeline instead, answered 404, and the route was filed unmeasured.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { publicScope, withAppUrl } from './measure-scope';
import { prerenderSite } from './prerender';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.measure-scope-fetch-fixture'));
const ORIGIN = 'https://example.test';
const CMS = 'https://cms.example/posts';

/** The network a scope hands an unowned url to: a stub that names every url it was asked. */
let dialled: string[] = [];
const sealed = globalThis.fetch;
const network = Object.assign(
  async (input: RequestInfo | URL): Promise<Response> => {
    dialled.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Response.json([{ title: 'from the cms' }]);
  },
  { preconnect: sealed.preconnect },
);

beforeEach(async () => {
  dialled = [];
  globalThis.fetch = network;
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'msf', version: '1.0.0' }));
});
afterEach(() => {
  globalThis.fetch = sealed;
  clearRoutes();
});
afterAll(() => rm(ROOT, { recursive: true, force: true }));

describe('unit · the urls a measurement scope answers in process', () => {
  const run = publicScope({ origin: ORIGIN, buildId: 'b1' });

  test("the app's own origin is answered by its API, never the network", async () => {
    const answer = await run(() => fetch(`${ORIGIN}/_x/query/nothing`));
    expect(answer.status).toBe(404);
    expect(dialled).toEqual([]);
  });

  test('another host reaches the network, as the page would in production', async () => {
    const answer = await run(() => fetch(CMS));
    expect(await answer.json()).toEqual([{ title: 'from the cms' }]);
    expect(dialled).toEqual([CMS]);
  });

  test('the APP_URL the typed client posts to is the app too, when it is not the build origin', async () => {
    const before = process.env['APP_URL'];
    process.env['APP_URL'] = 'https://api.example.test';
    try {
      const answer = await run(() => fetch('https://api.example.test/_x/query/nothing'));
      expect(answer.status).toBe(404);
      expect(dialled).toEqual([]);
    } finally {
      if (before === undefined) delete process.env['APP_URL'];
      else process.env['APP_URL'] = before;
    }
  });
});

describe('the build weighs a page that reads another host', () => {
  test('a load that reads a CMS is measured, not filed unmeasured', async () => {
    let posts: unknown;
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config: defineRoute({
        render: 'static',
        hydrate: 'never',
        offline: 'precache',
        budget: { js: '0kb' },
        meta: () => ({ title: 'Home', description: 'the landing page' }),
      }),
    });
    registerRoute({
      file: 'apps/web/app/news/page.tsx',
      config: defineRoute({
        render: 'ssr',
        hydrate: 'visible',
        offline: 'runtime',
        budget: { js: '60kb' },
        load: async () => {
          posts = await (await fetch(CMS)).json();
          return {};
        },
        meta: () => ({ title: 'News', description: 'from a cms' }),
      }),
    });
    const report = await withAppUrl(ORIGIN, () =>
      prerenderSite({ root: ROOT, out: join(ROOT, 'static'), origin: ORIGIN }),
    );
    expect(report.unmeasured).toEqual([]);
    expect(posts).toEqual([{ title: 'from the cms' }]);
    expect(dialled).toEqual([CMS]);
  }, 60_000);
});
