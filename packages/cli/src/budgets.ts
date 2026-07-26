// Per-route budgets. A blown budget is a build failure, not a Lighthouse report nobody read —
// and the finding names the import chain that caused it, because "your bundle got bigger" is not
// an actionable message for a human or an agent.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from './manifest-scan';
import { routesOf } from './manifest-scan';
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

/** `40kb` → 40960. Budgets are written the way humans write them; comparison is in bytes. */
export function parseBytes(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/i.exec(input.trim());
  if (match === null) return Number.NaN;
  const value = Number.parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'b').toLowerCase();
  if (unit === 'kb') return Math.round(value * 1024);
  if (unit === 'mb') return Math.round(value * 1024 * 1024);
  return Math.round(value);
}

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 ? `${Math.round(bytes / 102.4) / 10}kb` : `${bytes}b`;

interface RouteBudget {
  readonly js?: number;
  readonly lcp?: number;
}

function budgetOf(meta: Readonly<Record<string, unknown>>): RouteBudget | undefined {
  const budget = meta['budget'];
  if (typeof budget !== 'object' || budget === null) return undefined;
  const record = budget as Record<string, unknown>;
  const js = typeof record['js'] === 'string' ? parseBytes(record['js']) : undefined;
  const lcp = typeof record['lcp'] === 'number' ? record['lcp'] : undefined;
  return {
    ...(js === undefined || Number.isNaN(js) ? {} : { js }),
    ...(lcp === undefined ? {} : { lcp }),
  };
}

const chainOf = (stats: RouteStats): string =>
  stats.heaviestChain === undefined ? 'unknown import chain' : stats.heaviestChain.join(' -> ');

/** Compare declared budgets against measured stats. No stats = nothing to compare, not a pass. */
export function checkBudgets(manifest: AppManifest, stats: BuildStats): readonly Finding[] {
  const byPath = new Map(stats.routes.map((route) => [route.path, route]));
  const findings: Finding[] = [];
  for (const route of routesOf(manifest)) {
    const budget = budgetOf(route.meta);
    if (budget === undefined) continue;
    const measured = byPath.get(route.path ?? route.name);
    if (measured === undefined) continue;
    if (budget.js !== undefined && measured.jsBytes > budget.js) {
      findings.push({
        code: 'X_BUDGET_EXCEEDED',
        cause: `${route.path ?? route.name} ships ${formatBytes(measured.jsBytes)} of JS over a ${formatBytes(budget.js)} budget via ${chainOf(measured)}`,
        fix: `x routes --json to see the chain, then move the heavy import behind hydrate: 'interaction'`,
        docs: 'https://ultimate.dev/errors/X_BUDGET_EXCEEDED',
        at: route.file,
      });
    }
    if (budget.lcp !== undefined && measured.lcpMs !== undefined && measured.lcpMs > budget.lcp) {
      findings.push({
        code: 'X_BUDGET_EXCEEDED',
        cause: `${route.path ?? route.name} LCP ${measured.lcpMs}ms over the ${budget.lcp}ms budget`,
        fix: `raise the budget in defineRoute, or switch render to 'isr' to serve it prebuilt`,
        docs: 'https://ultimate.dev/errors/X_BUDGET_EXCEEDED',
        at: route.file,
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
