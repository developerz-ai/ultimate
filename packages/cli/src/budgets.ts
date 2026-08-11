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

const SCRIPT_TAG = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g;
const SRC_ATTR = /\ssrc="(?<src>[^"]*)"/;

/**
 * What a rendered document actually makes the browser execute: the bytes of every inline script
 * plus the size of every file a `src` points at. Measured from the emitted HTML rather than from
 * the declared graph, because the graph is what a route *says* it ships and this gate exists to
 * catch the case where those two disagree.
 */
export async function measureJsBytes(html: string, out: string): Promise<number> {
  let total = 0;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match.groups?.['attrs'] ?? '';
    const src = SRC_ATTR.exec(attrs)?.groups?.['src'];
    if (src === undefined) {
      total += Buffer.byteLength(match.groups?.['body'] ?? '', 'utf8');
      continue;
    }
    // Only a path inside the artifact can be weighed; a cross-origin script is not this build's.
    if (!src.startsWith('/')) continue;
    const file = Bun.file(join(out, src.slice(1)));
    total += (await file.exists()) ? file.size : 0;
  }
  return total;
}

/**
 * The file `checkBudgets` reads. Written by the build and by nothing else — a stats file produced
 * anywhere but from real output is the false green this gate exists to prevent.
 */
export async function writeBuildStats(root: string, stats: BuildStats): Promise<string> {
  const path = join(root, BUILD_STATS_FILE);
  await Bun.write(path, `${JSON.stringify(stats, null, 2)}\n`);
  return path;
}
