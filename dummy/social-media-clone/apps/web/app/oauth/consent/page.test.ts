// The consent page: what it declares, and both renders — a request it can answer shows the client,
// the scope in words and two native forms; one it cannot shows a refusal and no form at all.
//
// The page module is imported DYNAMICALLY, for the reason `dashboard/page.test.ts` gives.

import { beforeAll, expect, test } from 'bun:test';
import '@social-media-clone/i18n';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { renderComponent } from '@ultimat3/render/server';
import type { ConsentData } from './page';

const FILE = 'apps/web/app/oauth/consent/page.tsx';
const URL = 'http://localhost/oauth/consent';

let page: typeof import('./page');

beforeAll(async () => {
  page = await import('./page');
});

const render = (data: ConsentData): Promise<string> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u1' }), tz: 'UTC', locale: 'en' }), () =>
    renderComponent(() => page.Page({ data, url: URL }), {}, FILE),
  );

test('unit · the page is gated, ships no script and is never served from a cache', () => {
  expect(page.config.policy?.permission).toBe('oauth:consent');
  expect(page.config.hydrate).toBe('never');
  expect(page.config.budget?.js).toBe('0kb');
  expect(page.config.offline).toBe('network-only');
});

test('unit · an answerable request names the client and posts the request back twice', async () => {
  const html = await render({
    ok: true,
    client: 'Desktop',
    scopes: ['mcp'],
    request: 'a=1&b=2',
    redirectHost: 'app.example:8443',
    clientHost: 'client.example',
  });
  expect(html).toContain('data-redirect-host="app.example:8443"');
  expect(html).toContain('data-client-host="client.example"');
  expect(html).toContain('Desktop');
  expect(html).toContain('data-scope="mcp"');
  expect(html.match(/method="post" action="\/api\/connections\//g)).toHaveLength(2);
  expect(html).toContain('action="/api/connections/approve"');
  expect(html).toContain('action="/api/connections/deny"');
  expect(html.match(/name="request" value="a=1&amp;b=2"/g)).toHaveLength(2);
  expect(html).not.toContain('⟦');
});

test('unit · a refused request renders the reason and neither answer', async () => {
  const html = await render({ ok: false, reason: 'unknown client' });
  expect(html).toContain('data-refused="true"');
  expect(html).toContain('unknown client');
  expect(html).not.toContain('/api/connections/');
  expect(html).not.toContain('⟦');
});
