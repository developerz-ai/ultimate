import { beforeEach, describe, expect, test } from 'bun:test';
import { BudgetExceededError } from './errors';
import type { IslandDirective } from './hydrate';
import { hydrateRuntime } from './hydrate';
import type { Island } from './islands';
import { assertBudget, checkBudget, graphFor, parseByteBudget } from './islands';
import { clearRoutes, registerRoute } from './registry';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const islands: readonly Island[] = [
  {
    id: 'pricing-toggle',
    file: 'apps/web/site/pricing/toggle.tsx',
    graph: 'site',
    strategy: 'visible',
    bytes: 61 * 1024,
    heaviestChain: [
      'apps/web/site/pricing/page.tsx',
      'apps/web/shared/ui/button.tsx',
      'node_modules/chart.js',
    ],
  },
  {
    id: 'dashboard-chart',
    file: 'apps/web/app/reports/chart.tsx',
    graph: 'app',
    strategy: 'visible',
    bytes: 12 * 1024,
  },
];

beforeEach(() => {
  clearRoutes();
});

describe('parseByteBudget', () => {
  test('parses the budget units the route config accepts', () => {
    expect(parseByteBudget('40kb')).toBe(40_960);
    expect(parseByteBudget('512b')).toBe(512);
    expect(parseByteBudget('1mb')).toBe(1_048_576);
    expect(parseByteBudget('lots')).toBe(null);
    expect(parseByteBudget(undefined)).toBe(null);
  });
});

describe('two bundle graphs', () => {
  test('the site graph never contains an app island, and its baseline is 0kb', () => {
    const site = graphFor('site', islands);
    expect(site.baselineBytes).toBe(0);
    expect(site.islands.map((i) => i.id)).toEqual(['pricing-toggle']);
    expect(graphFor('app', islands).islands.map((i) => i.id)).toEqual(['dashboard-chart']);
  });
});

describe('checkBudget', () => {
  test('fails past budget.js and names the import chain that added the bytes', () => {
    const entry = registerRoute({
      file: 'apps/web/site/pricing/page.tsx',
      config: defineRoute({
        render: 'static',
        offline: 'precache',
        hydrate: 'visible',
        budget: { js: '40kb' },
        meta,
      }),
      islands: ['pricing-toggle'],
    });

    const report = checkBudget(entry, islands);
    expect(report.ok).toBe(false);
    expect(report.limit).toBe(40_960);
    expect(report.cause).toContain('js 61kb > 40kb');
    expect(report.cause).toContain('node_modules/chart.js');
    expect(() => assertBudget(entry, islands)).toThrow(BudgetExceededError);
  });

  test('passes under the limit and reports zero for a site route with no islands', () => {
    const entry = registerRoute({
      file: 'apps/web/site/about/page.tsx',
      config: defineRoute({ render: 'static', offline: 'precache', hydrate: 'never', meta }),
    });
    const report = checkBudget(entry, islands);
    expect(report.ok).toBe(true);
    expect(report.measured).toBe(0);
  });
});

describe('hydrateRuntime', () => {
  test('`never` islands emit no runtime at all', () => {
    const directives: readonly IslandDirective[] = [
      { islandId: 'a', strategy: 'never', entry: '/_x/a.js' },
    ];
    expect(hydrateRuntime(directives)).toBe('');
  });

  test('only the strategies in use are emitted', () => {
    const runtime = hydrateRuntime([
      { islandId: 'a', strategy: 'visible', entry: '/_x/a.js' },
      { islandId: 'b', strategy: 'interaction', entry: '/_x/b.js' },
    ]);
    expect(runtime).toContain('IntersectionObserver');
    expect(runtime).toContain('addEventListener');
    expect(runtime).not.toContain('requestIdleCallback');
  });
});
