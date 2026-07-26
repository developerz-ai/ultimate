// Panel: Routes.
// Kills: "which handler serves this?" — the route table with render mode, offline strategy,
// budget, and whether the route declares meta.

import type { RouteFact } from './facts';
import type { DevPanel } from './panel';

export interface RoutesPanelData {
  readonly routes: readonly RouteFact[];
  /** Counts per render mode: an app that is all `ssr` has a caching problem to find. */
  readonly byRenderMode: Readonly<Record<string, number>>;
  readonly missingMeta: readonly string[];
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
  titleKey: 'dev.panel.routes',
  question: 'which handler serves this?',
  async data(sources): Promise<RoutesPanelData> {
    const routes = await sources.routes();
    const byRenderMode: Record<string, number> = {};
    for (const route of routes) {
      byRenderMode[route.render] = (byRenderMode[route.render] ?? 0) + 1;
    }
    return {
      routes: [...routes].sort((a, b) => a.path.localeCompare(b.path)),
      byRenderMode,
      missingMeta: routes.filter((route) => !route.hasMeta).map((route) => route.path),
      overBudget: routes
        .filter((route) => kb(route.budget.js) > BUDGET_LIMIT_KB)
        .map((route) => route.path),
    };
  },
};
