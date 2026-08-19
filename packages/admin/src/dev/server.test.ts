import { describe, expect, test } from 'bun:test';
import { staticDevSources } from './data';
import { assertDevOnly, DEV_PANELS, devDashboard, devShellStyle } from './server';

const sources = staticDevSources({
  routes: async () => [
    {
      path: '/posts/:slug',
      render: 'isr',
      offline: 'precache',
      hydrate: 'visible',
      handler: 'site/posts/[slug].tsx',
      budget: { js: '80kb' },
      revalidateTags: ['post'],
    },
    {
      path: '/app',
      render: 'spa',
      offline: 'network-only',
      hydrate: 'idle',
      handler: 'app/index.tsx',
      budget: { js: '30kb' },
      revalidateTags: [],
    },
  ],
});

describe('/_x refuses to exist in production', () => {
  test('a production env is a throw at mount time, not a 404 later', () => {
    expect(() => devDashboard({ role: 'web', env: 'production' })).toThrow(
      /X_DEV_DASHBOARD_IN_PROD|policy traces/,
    );
    try {
      devDashboard({ role: 'web', env: 'production' });
    } catch (error) {
      const thrown = error as { code: string; fix: string };
      expect(thrown.code).toBe('X_DEV_DASHBOARD_IN_PROD');
      expect(thrown.fix).toContain('x dev');
    }
  });

  test('every production spelling is refused', () => {
    expect(() => assertDevOnly({ env: 'prod' })).toThrow();
    expect(() => assertDevOnly({ role: 'production', env: 'development' })).toThrow();
    expect(() => assertDevOnly({ role: 'web', env: 'development' })).not.toThrow();
  });

  // `ULTIMATE_ENV` is the framework's one environment key. This guard read `X_ENV`/`NODE_ENV`
  // only, so an app declaring production the documented way mounted /_x — SQL, policy traces and
  // caught mail — on the internet, and the `ROLE` half can never fire (`ROLES` is
  // web|sync|worker|scheduler|replicator|migrate, never `production`).
  test('ULTIMATE_ENV=production is refused with NODE_ENV unset', () => {
    const previousUltimate = process.env['ULTIMATE_ENV'];
    const previousNode = process.env['NODE_ENV'];
    const previousRole = process.env['ROLE'];
    try {
      process.env['ULTIMATE_ENV'] = 'production';
      delete process.env['NODE_ENV'];
      delete process.env['ROLE'];
      expect(() => assertDevOnly({})).toThrow(/X_DEV_DASHBOARD_IN_PROD/);

      delete process.env['ULTIMATE_ENV'];
      process.env['NODE_ENV'] = 'production';
      expect(() => assertDevOnly({})).toThrow(/X_DEV_DASHBOARD_IN_PROD/);

      // `ULTIMATE_ENV` is the one key and `NODE_ENV` only its fallback, so an operator who
      // declares this deploy development has declared it — one precedence, everywhere.
      process.env['ULTIMATE_ENV'] = 'development';
      expect(() => assertDevOnly({})).not.toThrow();

      delete process.env['ULTIMATE_ENV'];
      delete process.env['NODE_ENV'];
      expect(() => assertDevOnly({})).not.toThrow();
    } finally {
      if (previousUltimate === undefined) delete process.env['ULTIMATE_ENV'];
      else process.env['ULTIMATE_ENV'] = previousUltimate;
      if (previousNode === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNode;
      if (previousRole === undefined) delete process.env['ROLE'];
      else process.env['ROLE'] = previousRole;
    }
  });
});

describe('every panel is a rendering of its --json', () => {
  const dashboard = devDashboard({ role: 'web', env: 'development', sources });

  test('all nine panels are mounted, each with the question it kills', () => {
    expect(dashboard.panels.length).toBe(9);
    expect(dashboard.panels.map((panel) => panel.key)).toEqual([
      'routes',
      'timeline',
      'live',
      'jobs',
      'db',
      'mail',
      'cache',
      'policy',
      'manifest',
    ]);
    for (const panel of DEV_PANELS) expect(panel.questionKey.length).toBeGreaterThan(0);
  });

  test('the routes panel answers "which handler serves this?"', async () => {
    const payload = await dashboard.json('routes');
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const data = payload.data as {
      routes: { path: string; handler: string }[];
      byRenderMode: Record<string, number>;
      overBudget: string[];
    };
    expect(data.routes[0]?.handler).toBe('app/index.tsx');
    expect(data.byRenderMode).toEqual({ isr: 1, spa: 1 });
    expect(data.overBudget).toEqual(['/posts/:slug']);
    // `missingMeta` is gone, not renamed: `defineRoute()` refuses a route with no `meta`, so
    // the list could never have had a member and the panel filled it with EVERY route instead.
    expect(data).not.toHaveProperty('missingMeta');
  });

  test('the HTTP surface serves the same payload as --json', async () => {
    const html = await dashboard.handle(new Request('http://x/_x/routes'));
    const json = await dashboard.handle(new Request('http://x/_x/routes?json=1'));
    expect(html?.headers.get('content-type')).toContain('text/html');
    expect(json?.headers.get('content-type')).toContain('application/json');
    expect(await json?.json()).toEqual(await dashboard.json('routes'));
  });

  test('a request outside the mount is not ours', async () => {
    expect(await dashboard.handle(new Request('http://x/app'))).toBeNull();
  });

  test('an unknown panel names the ones that exist', async () => {
    const response = await dashboard.handle(new Request('http://x/_x/nope'));
    expect(response?.status).toBe(404);
    const payload = (await response?.json()) as { error: { cause: string } };
    expect(payload.error.cause).toContain('routes');
  });

  test('an unwired source shows the fix line instead of an empty panel', async () => {
    const bare = devDashboard({ env: 'development', panels: DEV_PANELS });
    const payload = await bare.json('manifest');
    expect(payload.ok).toBe(false);
    if (!payload.ok) {
      expect(payload.error.code).toBe('X_NOT_IMPLEMENTED');
      expect(payload.error.fix).toContain('defaultDevSources');
    }
  });
});

describe('devShellStyle', () => {
  test('is the exact body the served document inlines, so a host can hash it', async () => {
    // The host that mounts /_x configures the CSP those responses are sent under. If it hashed
    // anything other than this text the shell would be refused and every panel would render as
    // unstyled `<pre>` — the same failure the app's own pages shipped with.
    const style = await devShellStyle();
    const html = await devDashboard({ env: 'development', sources, panels: DEV_PANELS }).handle(
      new Request('http://x/_x/routes'),
    );
    expect(await html?.text()).toContain(`<style>${style}</style>`);
  });
});
