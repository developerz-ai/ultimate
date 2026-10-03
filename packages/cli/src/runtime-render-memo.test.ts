// The container keeps a `static` document after its first render (`memoStatic`). The keep was
// check-then-act: N cold requests that arrived together each missed the memo and each ran `load`
// and a render (s1-con, low). One render now answers every request that arrived during it.

import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'memo-under-test';
let loads = 0;

afterEach(() => {
  clearRoutes();
  loads = 0;
});

function staticPage(file: string, load: () => Promise<{ readonly n: number }>): void {
  registerRoute({
    file,
    config: defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'never',
      budget: { js: '0kb' },
      load,
      meta: () => ({ title: file, description: 'a static page rendered once' }),
    }),
  });
}

const serve = (memoStatic: boolean) =>
  createServer({
    routes: appRoutes({ buildId: BUILD_ID, memoStatic }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const burst = (server: ReturnType<typeof serve>, path: string, n: number): Promise<Response[]> =>
  Promise.all(
    Array.from({ length: n }, () =>
      server.fetch(new Request(`http://app.test${path}`, { headers: { accept: 'text/html' } })),
    ),
  );

describe('unit · a cold static page under a burst', () => {
  test('memoStatic: five concurrent requests run load once and answer the same bytes', async () => {
    staticPage('apps/web/site/precios/page.tsx', async () => {
      loads += 1;
      await Bun.sleep(5);
      return { n: loads };
    });
    const answers = await burst(serve(true), '/precios', 5);
    expect(loads).toBe(1);
    const bodies = await Promise.all(answers.map((answer) => answer.text()));
    expect(new Set(bodies).size).toBe(1);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
  });

  test('a load that throws fails every joined request, and the next request renders again', async () => {
    let fail = true;
    staticPage('apps/web/site/roto/page.tsx', async () => {
      loads += 1;
      await Bun.sleep(5);
      if (fail) {
        throw new UltimateError({
          code: 'X_ROUTE_LOAD_FAILED',
          cause: 'the load under test fails on purpose',
          fix: 'bun test packages/cli/src/runtime-render-memo.test.ts',
        });
      }
      return { n: loads };
    });
    const server = serve(true);
    const failed = await burst(server, '/roto', 3);
    expect(loads).toBe(1);
    expect(failed.every((answer) => answer.status >= 500)).toBe(true);
    fail = false;
    expect((await burst(server, '/roto', 1))[0]?.status).toBe(200);
  });

  test('without memoStatic (x dev) every request still renders', async () => {
    staticPage('apps/web/site/precios/page.tsx', async () => {
      loads += 1;
      return { n: loads };
    });
    await burst(serve(false), '/precios', 3);
    expect(loads).toBe(3);
  });
});
