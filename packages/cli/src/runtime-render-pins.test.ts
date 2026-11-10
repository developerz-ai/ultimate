// The pins a rendered document hands the browser: every action and query pinned with
// `http: { path }`, stamped by the server from the registries — so a browser caller reaching one
// by NAME goes where the declaration put it. An app that pins nothing — a static page included —
// renders no tag. Driven through `@ultimat3/http`'s real pipeline, like `runtime-render.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { resetQueries } from '@ultimat3/query';
import type { RenderMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { t } from '@ultimat3/schema';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'build-under-test';
const META = '<meta name="ultimate-pins"';

const PAGES: readonly {
  readonly render: RenderMode;
  readonly file: string;
  readonly path: string;
}[] = [
  { render: 'static', file: 'apps/web/site/page.tsx', path: '/' },
  { render: 'ssr', file: 'apps/web/app/account/page.tsx', path: '/account' },
];

function registerPages(): void {
  for (const page of PAGES) {
    registerRoute({
      file: page.file,
      config: defineRoute({
        render: page.render,
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        meta: () => ({ title: `page ${page.render}`, description: 'd'.repeat(60) }),
      }),
    });
  }
}

async function documentAt(path: string): Promise<string> {
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const response = await server.fetch(new Request(`http://dev.test${path}`));
  expect(response.status).toBe(200);
  return response.text();
}

const refund = (http?: { path: string; method: 'PUT' }) =>
  action({
    input: t.object({ id: t.string }),
    output: t.object({ ok: t.boolean }),
    policy: allow('order:refund'),
    ...(http === undefined ? {} : { http }),
    handle: () => ({ ok: true }),
  });

const clean = (): void => {
  clearRoutes();
  resetActions();
  resetQueries();
};
// Before too: an earlier file in this process may have left a pinned action or a route behind.
beforeEach(clean);
afterEach(clean);

describe('unit · a document carries the pins its server serves', () => {
  test('a pinned action is stamped into the head of every document', async () => {
    registerAction('refundOrder', refund({ path: '/orders/:id/refund', method: 'PUT' }));
    registerPages();
    for (const page of PAGES) {
      const head = (await documentAt(page.path)).split('</head>')[0] ?? '';
      expect(head).toContain(
        `${META} content="{&quot;a&quot;:{&quot;refundOrder&quot;:&quot;PUT /orders/:id/refund&quot;}}">`,
      );
    }
  });

  test('an app that pins nothing renders no tag, a static page included', async () => {
    registerAction('likePost', refund());
    registerPages();
    for (const page of PAGES) {
      expect(await documentAt(page.path)).not.toContain('ultimate-pins');
    }
  });
});
