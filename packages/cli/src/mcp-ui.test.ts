import { describe, expect, test } from 'bun:test';
import { fakeBrowser } from '@ultimat3/scraping';
import { assertBudgetedRoute, matches, uiCapabilities } from './mcp-ui';
import { ISLAND_PROBE } from './shot-verdict';

const ROUTES = [
  { path: '/', file: 'apps/web/site/page.tsx', budgetJs: '0kb' },
  { path: '/dashboard', file: 'apps/web/app/dashboard/page.tsx', budgetJs: '126kb' },
  { path: '/links/:slug', file: 'apps/web/app/links/[slug]/page.tsx', budgetJs: '94kb' },
  { path: '/draft', file: 'apps/web/site/draft/page.tsx', budgetJs: null },
];

describe('unit · ui.shot only photographs a declared, budgeted route', () => {
  test('a param segment matches one path segment, and nothing more', () => {
    expect(matches('/links/:slug', '/links/abc123')).toBe(true);
    expect(matches('/links/:slug', '/links/abc123/edit')).toBe(false);
    expect(matches('/links/:slug', '/links')).toBe(false);
    expect(matches('/', '/')).toBe(true);
    expect(matches('/dashboard', '/dashboards')).toBe(false);
  });

  test('a budgeted route passes, with or without a query string', () => {
    expect(() => assertBudgetedRoute('/dashboard', ROUTES)).not.toThrow();
    expect(() => assertBudgetedRoute('/links/abc123?ref=x', ROUTES)).not.toThrow();
  });

  test('an unknown path is refused by name, with the tool that lists the real ones', () => {
    expect(() => assertBudgetedRoute('/nope', ROUTES)).toThrow(
      expect.objectContaining({ code: 'X_UI_SHOT_ROUTE_UNKNOWN' }),
    );
  });

  test('a route with no budget.js is refused — a picture of a draft judges the wrong thing', () => {
    try {
      assertBudgetedRoute('/draft', ROUTES);
      expect.unreachable('should have refused');
    } catch (error) {
      const refusal = error as { code: string; fix: string; cause: string };
      expect(refusal.code).toBe('X_UI_SHOT_ROUTE_UNBUDGETED');
      expect(refusal.cause).toContain('apps/web/site/draft/page.tsx');
      expect(refusal.fix).toContain('budget: { js:');
    }
  });
});

const SERVER_URL = 'http://localhost:4321';
const CLEAN = JSON.stringify({
  declared: 1,
  booted: 1,
  mounted: 1,
  failed: 0,
  byStrategy: { idle: 1 },
  failures: [],
});
const PAGE =
  '<!doctype html><html><body><div data-x-island="i1" data-x-hydrate="idle" data-x-entry="/_x/islands/a.js"></div></body></html>';

describe('unit · ui.shot boots the server it photographs once per host, never once per call', () => {
  test('two calls share one boot; runShot cannot stop it; close() does, once', async () => {
    // No `node:` import for a scratch directory: Bun's shell makes and removes it.
    const root = `${process.env['TMPDIR'] ?? '/tmp'}/ui-shot-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${root}`.quiet();
    let boots = 0;
    let stops = 0;
    const ui = uiCapabilities({
      root,
      env: {},
      boot: async () => {
        boots += 1;
        return {
          url: SERVER_URL,
          origin: 'booted',
          stop: async () => {
            stops += 1;
          },
        };
      },
      driver: async () =>
        fakeBrowser([
          { url: `${SERVER_URL}/dash`, html: PAGE, evaluate: { [ISLAND_PROBE]: CLEAN } },
        ]),
      routes: () => [{ path: '/dash', file: 'apps/web/app/dash/page.tsx', budgetJs: '10kb' }],
    });
    try {
      const shot = {
        route: '/dash',
        viewport: { width: 390, height: 844 },
        colorScheme: 'dark' as const,
        fullPage: true,
      };
      const first = await ui.shotRoute(shot);
      const second = await ui.shotRoute({ ...shot, colorScheme: 'light' });
      // The second call is what used to answer X_LIFECYCLE_DRAINED: one boot serves both.
      expect(boots).toBe(1);
      // `runShot` stops the server it is handed at the end of every capture — and must not have
      // stopped THIS one, which outlives the call.
      expect(stops).toBe(0);
      expect(first.ok).toBe(true);
      // One directory per (route, viewport, scheme): the two pictures do not overwrite each other.
      expect(first.image).not.toBe(second.image);
      expect(first.image).toContain('390x844-dark');
      expect(second.image).toContain('390x844-light');
      await ui.close();
      await ui.close();
      expect(stops).toBe(1);
    } finally {
      await Bun.$`rm -rf ${root}`.quiet();
    }
  });

  test('close() with nothing booted boots nothing', async () => {
    let boots = 0;
    const ui = uiCapabilities({
      root: '/nowhere',
      env: {},
      boot: async () => {
        boots += 1;
        return { url: SERVER_URL, origin: 'booted', stop: async () => undefined };
      },
    });
    await ui.close();
    expect(boots).toBe(0);
  });
});
