// Per-route budgets. A blown budget is a build failure, not a Lighthouse report nobody read —
// and the finding names the import chain that caused it, because "your bundle got bigger" is not
// an actionable message for a human or an agent.
//
// Byte parsing and formatting come from `@ultimat3/render`, which owns the budget vocabulary the
// routes are declared in. The one thing that lives here is the comparison against MEASURED bytes:
// render checks a bundle graph, this checks what the build actually emitted.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, RouteFact } from '@ultimat3/manifest';
import { formatBytes, parseByteBudget } from '@ultimat3/render';
import type { Finding } from './output';

export const BUILD_STATS_FILE = join('.x', 'build-stats.json');

export interface RouteStats {
  readonly path: string;
  readonly jsBytes: number;
  readonly lcpMs?: number;
  /** Import chain that pulled the heaviest module into this route. */
  readonly heaviestChain?: readonly string[];
}

export interface BuildStats {
  readonly routes: readonly RouteStats[];
}

const chainOf = (stats: RouteStats): string =>
  stats.heaviestChain === undefined ? 'unknown import chain' : stats.heaviestChain.join(' -> ');

const jsBudgetOf = (route: RouteFact): number | null => parseByteBudget(route.budget?.js);

/** Which budgets the route declared, for a cause line that names what went unmeasured. */
function declaredBudgets(js: number | null, lcp: number | undefined): string {
  const labels: string[] = [];
  if (js !== null) labels.push('JS');
  if (lcp !== undefined) labels.push('LCP');
  return labels.join(' and ');
}

/**
 * Compare declared budgets against measured stats. A declared budget with no measurement is a
 * finding, never a pass: a route that clears the gate without ever being weighed is exactly the
 * false green axiom 5 exists to prevent. Only a route that declares nothing is skipped.
 */
export function checkBudgets(manifest: Manifest, stats: BuildStats): readonly Finding[] {
  const byPath = new Map(stats.routes.map((route) => [route.path, route]));
  const findings: Finding[] = [];
  for (const route of manifest.routes) {
    const measured = byPath.get(route.url);
    const js = jsBudgetOf(route);
    const lcp = route.budget?.lcp;
    if (measured === undefined) {
      if (js !== null || lcp !== undefined) {
        findings.push({
          code: 'X_BUDGET_UNMEASURED',
          cause: `${route.url} declares a ${declaredBudgets(js, lcp)} budget but ${BUILD_STATS_FILE} has no entry for it`,
          fix: 'x build && x verify',
          docs: 'https://ultimate.dev/errors/X_BUDGET_UNMEASURED',
          at: route.url,
        });
      }
      continue;
    }
    if (js !== null && measured.jsBytes > js) {
      findings.push({
        code: 'X_BUDGET_EXCEEDED',
        cause: `${route.url} ships ${formatBytes(measured.jsBytes)} of JS over a ${formatBytes(js)} budget via ${chainOf(measured)}`,
        fix: `x routes --json to see the chain, then move the heavy import behind hydrate: 'interaction'`,
        docs: 'https://ultimate.dev/errors/X_BUDGET_EXCEEDED',
        at: route.url,
      });
    }
    if (lcp !== undefined && measured.lcpMs !== undefined && measured.lcpMs > lcp) {
      findings.push({
        code: 'X_BUDGET_EXCEEDED',
        cause: `${route.url} LCP ${measured.lcpMs}ms over the ${lcp}ms budget`,
        fix: `raise the budget in defineRoute, or switch render to 'isr' to serve it prebuilt`,
        docs: 'https://ultimate.dev/errors/X_BUDGET_EXCEEDED',
        at: route.url,
      });
    }
  }
  return findings;
}

export async function readBuildStats(root: string): Promise<BuildStats | undefined> {
  const path = join(root, BUILD_STATS_FILE);
  if (!existsSync(path)) return undefined;
  return (await Bun.file(path).json()) as BuildStats;
}
