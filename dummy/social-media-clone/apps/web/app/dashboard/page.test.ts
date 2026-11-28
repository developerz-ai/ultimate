// The dashboard: what it declares, and what it emits for a signed-in viewer over the seeded graph.
//
// The page module is imported DYNAMICALLY for the rendering half: Bun loads a file's static
// imports before executing any of them, so a static import would compile before
// `@ultimat3/render`'s module scope installs the `.tsx` loader.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through, and without it every `t()` here
// renders ⟦key⟧ — which the last assertion is what checks for.
import '@social-media-clone/i18n';
import { seedDemo } from '@social-media-clone/db';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import { renderRoute } from '@ultimat3/testing';
import type { Actor } from '../../shared/actor';
import { userById } from '../auth/repo';
import { actorFor } from '../auth/viewer';
import { dashboardScreen } from './screen';

const URL = 'http://localhost/dashboard';

let page: typeof import('./page');
let viewer: Actor;

beforeAll(async () => {
  page = await import('./page');
  await seedDemo();
  const user = await userById(seedId('user:user'));
  if (user === null) return expect.unreachable('the seed writes user:user');
  viewer = await actorFor(user);
});

/** Through `renderRoute`: the page declares an island, and only a route render collects one. */
const render = async (data: Parameters<typeof page.Page>[0]['data']): Promise<string> =>
  (
    await runWithContext(ctxOf({ actor: viewer, tz: 'UTC', locale: 'en' }), () =>
      renderRoute(
        { ...page, config: { ...page.config, load: () => Promise.resolve(data) } },
        { url: URL, actor: viewer },
      ),
    )
  ).html;

const stat = (html: string, name: string): string | undefined =>
  html.match(new RegExp(`data-stat="${name}">([^<]*)<`))?.[1];

test('unit · the dashboard renders on the server, is gated, and has an offline strategy', () => {
  expect(page.config.render).toBe('ssr');
  expect(page.config.policy?.permission).toBe('dashboard:read');
  expect(page.config.offline).toBe('runtime');
  expect(page.config.budget?.js).toBe('60kb');
});

test('unit · the figures, both charts and the table render from the screen, with no script', async () => {
  const screen = await dashboardScreen(viewer, new Date('2026-10-05T12:00:00.000Z'));
  const html = await render({ screen });
  expect(stat(html, 'dashboard-posts')).toBe(String(screen.stats.posts));
  expect(stat(html, 'dashboard-friends')).toBe(String(screen.stats.friends));
  expect(stat(html, 'dashboard-waiting')).toBe(String(screen.stats.waiting));
  // The trend draws two filled series; the ring one segment per state that has people.
  expect(html.match(/data-area="true"/g)).toHaveLength(2);
  const states = Object.values(screen.connections).filter((n) => n > 0).length;
  expect(html.match(/data-segment="/g)).toHaveLength(states);
  // One table row per most-liked post, each likes figure with its in-cell bar.
  expect(html.match(/<tr[^>]*\sdata-row=/g)).toHaveLength(screen.top.length);
  expect(html.match(/data-inline-bar-value/g)).toHaveLength(screen.top.length);
  expect(html).not.toContain('<script type="module"');
  expect(html).not.toContain('⟦');
});

test('unit · it still points at every gated screen, inside the signed-in shell', async () => {
  const html = await render({ screen: null });
  for (const href of ['/friends', '/messages', '/notifications', '/feed']) {
    expect(html).toContain(`href="${href}"`);
  }
  // The header knows this actor is signed in, so the session control is a sign-out.
  expect(html).toContain('action="/api/sessions/destroy"');
  // No viewer, no figures: the page never invents a zero for somebody it could not name.
  expect(html).not.toContain('data-stat=');
  expect(html).not.toContain('⟦');
});

// The motion is the island's, and the page is complete without it: the same figures the tiles drew
// are the counts the island is told to end on, the cards it staggers carry their hook, and a notice
// slot exists only when someone is waiting.
test('unit · the island counts up exactly the figures the server drew', async () => {
  const screen = await dashboardScreen(viewer, new Date('2026-10-05T12:00:00.000Z'));
  const html = await render({ screen });
  const props = html.match(/data-x-props="dashboard-motion-1">([^<]*)</)?.[1] ?? '';
  const sent = JSON.parse(props) as {
    counts: Record<string, number>;
    waiting: { text: string; href: string } | null;
  };
  expect(sent.counts).toEqual({
    'dashboard-posts': screen.stats.posts,
    'dashboard-likes': screen.stats.likes,
    'dashboard-friends': screen.stats.friends,
    'dashboard-waiting': screen.stats.waiting,
  });
  expect(html.match(/data-reveal=/g)).toHaveLength(4);
  expect(html.includes('data-slot="waiting"')).toBe(screen.stats.waiting > 0);
  expect(sent.waiting === null).toBe(screen.stats.waiting === 0);
  // Signed out of any figures: no figures to count, so no island either.
  expect(await render({ screen: null })).not.toContain('data-x-props');
});
