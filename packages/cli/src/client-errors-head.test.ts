// `DocumentOptions.appHead` — the reporter's tag — on every `app/` document in every mode it allows,
// and on NO `site/` document: the static path never pays for the app path (axiom 6).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RenderMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute, SURFACE_SPECS } from '@ultimat3/render';
import { clientErrorsHead } from './client-errors-routes';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'build-under-test';
const HEAD = clientErrorsHead(BUILD_ID);

const PAGES = [
  { surface: 'site', file: 'apps/web/site/page.tsx', url: '/', carries: false },
  { surface: 'app', file: 'apps/web/app/feed/page.tsx', url: '/feed', carries: true },
] as const;
const CASES = PAGES.flatMap((page) =>
  SURFACE_SPECS[page.surface].allowedModes.map((render) => ({ ...page, render })),
);

function register(file: string, render: RenderMode): void {
  registerRoute({
    file,
    config: defineRoute({
      render,
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: 'a page', description: 'a page under test' }),
      ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
    }),
  });
}

beforeEach(() => resetLifecycle());
afterEach(() => {
  clearRoutes();
  resetLifecycle();
});

describe('unit · the client error reporter tag', () => {
  test.each(CASES)(
    '$surface/ in $render: carried = $carries',
    async ({ file, url, render, carries }) => {
      register(file, render);
      const server = httpServer({
        routes: appRoutes({ buildId: BUILD_ID, appHead: HEAD }),
        role: 'web',
        config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
      });
      const body = await (await server.fetch(new Request(`http://dev.test${url}`))).text();
      const head = body.slice(0, body.indexOf('</head>'));
      if (carries) expect(head).toContain(HEAD);
      else expect(body).not.toContain('x-client-errors');
    },
  );
});
