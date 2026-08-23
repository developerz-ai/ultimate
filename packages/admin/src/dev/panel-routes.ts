// Panel: Routes.
// Kills: "which handler serves this?" — the route table with render mode, offline strategy
// and budget.

import type { RouteFact } from './facts';
import type { DevPanel } from './panel';

export interface RoutesPanelData {
  readonly routes: readonly RouteFact[];
  /** Counts per render mode: an app that is all `ssr` has a caching problem to find. */
  readonly byRenderMode: Readonly<Record<string, number>>;
  // No `missingMeta`. `defineRoute()` refuses a route without a `meta` function, so the list had
  // no member it could ever hold — and it was published from a `RouteFact.hasMeta` that read a
  // key no descriptor has, which made it name EVERY route instead. See `RouteFact` in `facts.ts`.
  readonly overBudget: readonly string[];
}

const BUDGET_LIMIT_KB = 40;

const kb = (budget: string | undefined): number => {
  if (budget === undefined) return 0;
  const parsed = Number.parseFloat(budget);
  return Number.isNaN(parsed) ? 0 : budget.toLowerCase().endsWith('mb') ? parsed * 1024 : parsed;
};

export const routesPanel: DevPanel<RoutesPanelData> = {
  key: 'routes',
  titleKey: 'dev.panel.routes.title',
  questionKey: 'dev.panel.routes.question',
  async data(sources): Promise<RoutesPanelData> {
    const routes = await sources.routes();
    // A `Map`, then `Object.fromEntries`. See `panel-cache.ts` for why the plain-object counter is
    // wrong: an inherited name reads a prototype value instead of `undefined`, and `__proto__`
    // writes through the setter rather than adding a key.
    const counts = new Map<string, number>();
    for (const route of routes) counts.set(route.render, (counts.get(route.render) ?? 0) + 1);
    const byRenderMode = Object.fromEntries(counts);
    return {
      routes: [...routes].sort((a, b) => a.path.localeCompare(b.path)),
      byRenderMode,
      overBudget: routes
        .filter((route) => kb(route.budget.js) > BUDGET_LIMIT_KB)
        .map((route) => route.path),
    };
  },
};
