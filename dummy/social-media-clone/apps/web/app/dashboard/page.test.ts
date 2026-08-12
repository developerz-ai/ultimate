// The dashboard: what it declares, and what it emits.
//
// The page module is imported DYNAMICALLY for the rendering half: Bun loads a file's static
// imports before executing any of them, so a static import would compile before
// `@ultimat3/render`'s module scope installs the `.tsx` loader.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through, and without it every `t()` here
// renders ⟦key⟧ — which the last assertion is what checks for.
import '@social-media-clone/i18n';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { renderComponent } from '@ultimat3/render';

const FILE = 'apps/web/app/dashboard/page.tsx';

let page: typeof import('./page');

beforeAll(async () => {
  page = await import('./page');
});

test('unit · the dashboard renders on the server, is gated, and has an offline strategy', () => {
  expect(page.config.render).toBe('ssr');
  expect(page.config.policy?.permission).toBe('dashboard:read');
  expect(page.config.offline).toBe('runtime');
});

test('unit · it points at every gated screen, inside the signed-in shell', async () => {
  const html = await runWithContext(
    createContext({ actor: userActor({ id: 'seeded-user', roles: ['member'] }), tz: 'UTC' }),
    () => renderComponent(page.DashboardPage, { url: 'http://localhost/dashboard' }, FILE),
  );

  for (const href of ['/friends', '/messages', '/notifications', '/feed']) {
    expect(html).toContain(`href="${href}"`);
  }
  // The header knows this actor is signed in, so the session control is a sign-out.
  expect(html).toContain('action="/api/sessions/destroy"');
  expect(html).not.toContain('⟦');
});
