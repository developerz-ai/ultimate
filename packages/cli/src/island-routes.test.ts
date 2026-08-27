// The other half of the same seam: what `x dev` and the container serve. Driven through
// `@ultimat3/http`'s real pipeline against a real bundle, because the claim being tested is that
// the URL the document carries is a URL this process answers — a stub on either side proves nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { clearRoutes, defineRoute, island, registerRoute } from '@ultimat3/render';
import { appRoutes } from './dev-render';
import { fixProblem } from './error-contract';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { islandRoutes } from './island-routes';

const ROOT = join(import.meta.dir, '..', '.island-routes-fixture');
const BUILD_ID = 'islands-under-test';

const COUNTER = 'export function mount(el: HTMLElement): void { el.textContent = "hydrated"; }\n';

const Counter = island({ src: './counter.island.tsx' });

const config = defineRoute({
  render: 'ssr',
  hydrate: 'interaction',
  offline: 'network-only',
  budget: { js: '20kb' },
  meta: () => ({ title: 'Counter', description: 'one island' }),
});

const serve = (bundle: IslandBundle): ReturnType<typeof createServer> =>
  createServer({
    routes: [
      ...islandRoutes(() => bundle),
      ...appRoutes({
        buildId: BUILD_ID,
        resolveIsland: (file: string) => bundle.resolverFor(file),
      }),
    ],
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'apps/web/site/counter.island.tsx'), COUNTER);
});

afterEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
});

describe('islands over HTTP', () => {
  test('the document names a chunk this process answers, with the runtime that boots it', async () => {
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config,
      component: () => Counter({ children: 'inert' }),
    });
    const server = serve(await buildIslands(ROOT));

    const page = await server.fetch(new Request('http://dev.test/'));
    const html = await page.text();
    const url = /data-x-entry="(?<url>[^"]+)"/.exec(html)?.groups?.['url'] ?? '';
    expect(url).toMatch(/^\/islands\/counter-[0-9a-f]{8}\.js$/);
    // `interaction` earns the replay listener; without it the first click on a cold island is lost.
    expect(html).toContain('data-x-hydrate="interaction"');
    expect(html).toContain('addEventListener');

    const chunk = await server.fetch(new Request(`http://dev.test${url}`));
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get('content-type')).toContain('javascript');
    // Content-addressed, so the bytes behind the URL can never change.
    expect(chunk.headers.get('cache-control')).toContain('immutable');
    expect(await chunk.text()).toContain('hydrated');
  });

  test('a URL from an older build is refused with a cause and a command, not a bare 404', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config, component: () => 'no island' });
    const response = await serve(await buildIslands(ROOT)).fetch(
      new Request('http://dev.test/islands/counter-deadbeef.js'),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: { code?: string; fix?: string } };
    expect(body.error?.code).toBe('X_ROUTE_NOT_FOUND');
    const fix = body.error?.fix ?? '';
    // NOT `x build --target static`, which is what this said and what this test used to accept.
    // This route is mounted in exactly two places — `cmd-dev.ts` and `serve.ts` — and NEITHER
    // reads `.x/static`: `x dev` rebuilds the chunks on the watcher tick and the container built
    // them at boot, so running that command changes nothing for either process and the reader is
    // left where they started. `dev-lock.ts`'s shape instead: the concrete act, no citation.
    expect(fix).not.toContain('x build');
    expect(fix).toMatch(/reload/i);
    // Still a fix the contract accepts — an instruction with no command is legal, advice is not.
    expect(fixProblem(fix)).toBeUndefined();
  });

  test('a page with no island serves no runtime at all — the 0kb baseline is the default', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config, component: () => 'plain' });
    const html = await (
      await serve(await buildIslands(ROOT)).fetch(new Request('http://dev.test/'))
    ).text();

    expect(html).toContain('plain');
    expect(html).not.toContain('<script');
  });
});
