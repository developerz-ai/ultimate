// Per-route performance budgets. `checkBudgets()` returns a `--json`-shaped
// report; `x verify` fails CI on it. A budget that only warns is a budget that
// gets ignored, so the assert path throws X_BUDGET_EXCEEDED naming the route file.

import { budgetExceeded, SEO_ERROR_CODES, SeoError } from './errors';
import type { RouteBudget, RouteRecord } from './routes';

/** Core Web Vitals "good" thresholds, as of 2026-07. */
export const DEFAULT_BUDGET: Required<Pick<RouteBudget, 'lcp' | 'cls' | 'inp'>> = {
  lcp: 2500,
  cls: 0.1,
  inp: 200,
};

export type BudgetMetric = 'js' | 'css' | 'lcp' | 'cls' | 'inp';

export const BUDGET_UNITS: Readonly<Record<BudgetMetric, string>> = {
  js: 'b',
  css: 'b',
  lcp: 'ms',
  cls: '',
  inp: 'ms',
};

/** What a build or a lab run measured for one route. */
export interface BudgetMeasurement {
  route: string;
  js?: number;
  css?: number;
  lcp?: number;
  cls?: number;
  inp?: number;
}

export interface BudgetViolation {
  readonly route: string;
  readonly file: string;
  readonly metric: BudgetMetric;
  readonly limit: number;
  readonly actual: number;
  readonly overBy: number;
  readonly unit: string;
}

export interface BudgetReport {
  readonly ok: boolean;
  readonly checked: number;
  readonly violations: readonly BudgetViolation[];
}

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
};

/** `'40kb'` -> 40960. A raw number is already bytes. */
export function parseBytes(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)?\s*$/i.exec(value);
  if (match === null) {
    throw new SeoError({
      code: SEO_ERROR_CODES.budgetExceeded,
      cause: `budget size ${JSON.stringify(value)} is not a byte count or a size string`,
      fix: "write the budget as a number of bytes or a string like '40kb'",
      meta: { value },
    });
  }
  const scale = BYTE_UNITS[(match[2] ?? 'b').toLowerCase()] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

function limitOf(budget: RouteBudget, metric: BudgetMetric): number | undefined {
  if (metric === 'js' || metric === 'css') {
    const raw = budget[metric];
    return raw === undefined ? undefined : parseBytes(raw);
  }
  return budget[metric] ?? DEFAULT_BUDGET[metric];
}

export function checkBudgets(
  routes: readonly RouteRecord[],
  measurements: readonly BudgetMeasurement[],
): BudgetReport {
  const byRoute = new Map(measurements.map((measurement) => [measurement.route, measurement]));
  const violations: BudgetViolation[] = [];
  let checked = 0;

  for (const route of routes) {
    const measured = byRoute.get(route.path);
    if (measured === undefined) continue;
    checked += 1;
    const budget = route.budget ?? {};

    for (const metric of ['js', 'css', 'lcp', 'cls', 'inp'] as const) {
      const actual = measured[metric];
      const limit = limitOf(budget, metric);
      if (actual === undefined || limit === undefined) continue;
      if (actual <= limit) continue;
      violations.push({
        route: route.path,
        file: route.file,
        metric,
        limit,
        actual,
        overBy: Number((actual - limit).toFixed(4)),
        unit: BUDGET_UNITS[metric],
      });
    }
  }

  return { ok: violations.length === 0, checked, violations };
}

/** Fails the build on the first violation. `x verify` calls this. */
export function assertBudgets(report: BudgetReport): void {
  const first = report.violations[0];
  if (first === undefined) return;
  throw budgetExceeded(
    first.route,
    first.file,
    first.metric,
    first.limit,
    first.actual,
    first.unit,
  );
}
