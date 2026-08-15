/**
 * Island boundaries and the two separate bundle graphs. `site/` and `app/` never share a
 * graph: that is the mechanical half of axiom 6 (the surface boundary in `surfaces.ts` is
 * the other half). `site/` starts at a 0kb baseline and every byte after that is an
 * opt-in, budgeted island.
 */

import { BudgetExceededError } from './errors';
import type { IslandDirective } from './hydrate';
import { hydrateRuntimeBytes } from './hydrate';
import type { RouteEntry } from './registry';
import type { HydrateStrategy } from './route';
import type { Surface } from './surfaces';
import { SURFACE_SPECS } from './surfaces';

/** A bundle graph is per surface. There are exactly two that ship JS: `site` and `app`. */
export type GraphName = 'site' | 'app';

export interface Island {
  readonly id: string;
  readonly file: string;
  readonly graph: GraphName;
  readonly strategy: HydrateStrategy;
  /** Measured from the real bundle, gzip-before-brotli agnostic: raw bytes. */
  readonly bytes: number;
  /** The import chain that pulled the heaviest dependency in, for error messages. */
  readonly heaviestChain?: readonly string[];
}

export interface BundleGraph {
  readonly name: GraphName;
  readonly baselineBytes: number;
  readonly islands: readonly Island[];
}

export function graphFor(surface: Surface, islands: readonly Island[]): BundleGraph {
  const name: GraphName = surface === 'site' ? 'site' : 'app';
  return {
    name,
    baselineBytes: SURFACE_SPECS[name].jsBaselineBytes,
    islands: islands.filter((island) => island.graph === name && island.strategy !== 'never'),
  };
}

const UNITS: Readonly<Record<string, number>> = { b: 1, kb: 1024, mb: 1024 * 1024 };

/** `'40kb'` → 40960. Throws nothing: an unparseable budget is `null` and skipped. */
export function parseByteBudget(budget: string | undefined): number | null {
  if (budget === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/i.exec(budget.trim());
  const amount = match?.[1];
  const unit = match?.[2]?.toLowerCase();
  if (amount === undefined || unit === undefined) return null;
  const factor = UNITS[unit];
  return factor === undefined ? null : Math.round(Number(amount) * factor);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  return `${Math.round((bytes / 1024) * 10) / 10}kb`;
}

export interface RouteBytes {
  readonly total: number;
  readonly baseline: number;
  readonly islandBytes: number;
  readonly runtimeBytes: number;
  readonly heaviest: Island | null;
}

export function routeJsBytes(
  entry: RouteEntry,
  islands: readonly Island[],
  directives: readonly IslandDirective[] = [],
): RouteBytes {
  const graph = graphFor(entry.surface, islands);
  // Two sources, unioned: `entry.islands` is what registration declared, and the directives are
  // what the page actually rendered. Reading only the first is how the runtime bytes of an island
  // could be charged while its chunk was not — a budget that counts the wrapper and not the code.
  const onRoute = graph.islands.filter(
    (island) =>
      entry.islands.includes(island.id) ||
      directives.some((directive) => (directive.moduleId ?? directive.islandId) === island.id),
  );
  const islandBytes = onRoute.reduce((sum, island) => sum + island.bytes, 0);
  const runtimeBytes = directives.length > 0 ? hydrateRuntimeBytes(directives) : 0;
  const baseline = islandBytes === 0 && runtimeBytes === 0 ? 0 : graph.baselineBytes;
  const heaviest = onRoute.reduce<Island | null>(
    (max, island) => (max === null || island.bytes > max.bytes ? island : max),
    null,
  );
  return {
    total: baseline + islandBytes + runtimeBytes,
    baseline,
    islandBytes,
    runtimeBytes,
    heaviest,
  };
}

export interface BudgetReport {
  readonly path: string;
  readonly measured: number;
  readonly limit: number | null;
  readonly ok: boolean;
  readonly cause: string | null;
}

/**
 * The build gate. Failure names the *cause* — the island and the transitive import that
 * added the bytes — because "bundle too big" without a chain is not an instruction.
 */
export function checkBudget(
  entry: RouteEntry,
  islands: readonly Island[],
  directives: readonly IslandDirective[] = [],
): BudgetReport {
  const bytes = routeJsBytes(entry, islands, directives);
  const limit = parseByteBudget(entry.config.budget.js);

  // site/ has a 0kb default: shipping JS there without declaring a budget is the failure.
  if (limit === null && entry.surface === 'site' && bytes.total > 0) {
    return {
      path: entry.path,
      measured: bytes.total,
      limit: 0,
      ok: false,
      cause:
        `${entry.path} is in site/ (0kb JS baseline) and ships ${formatBytes(bytes.total)} ` +
        `with no budget.js${chainOf(bytes.heaviest)}`,
    };
  }

  if (limit === null) {
    return { path: entry.path, measured: bytes.total, limit: null, ok: true, cause: null };
  }

  const ok = bytes.total <= limit;
  return {
    path: entry.path,
    measured: bytes.total,
    limit,
    ok,
    cause: ok
      ? null
      : `${entry.path}  js ${formatBytes(bytes.total)} > ${formatBytes(limit)}${chainOf(bytes.heaviest)}`,
  };
}

function chainOf(island: Island | null): string {
  if (island === null) return '';
  const chain = island.heaviestChain;
  if (chain === undefined || chain.length === 0) return ` (heaviest island: ${island.file})`;
  return ` (${chain.join(' → ')})`;
}

export function assertBudget(
  entry: RouteEntry,
  islands: readonly Island[],
  directives: readonly IslandDirective[] = [],
): void {
  const report = checkBudget(entry, islands, directives);
  if (report.ok || report.cause === null) return;
  throw new BudgetExceededError(
    report.cause,
    `raise budget.js in ${entry.file} deliberately, or remove the import that added the bytes`,
  );
}

/** `x verify` prints every route, not just the first failure. */
export function checkBudgets(
  entries: readonly RouteEntry[],
  islands: readonly Island[],
): readonly BudgetReport[] {
  return entries
    .map((entry) => checkBudget(entry, islands))
    .sort((a, b) => a.path.localeCompare(b.path));
}
