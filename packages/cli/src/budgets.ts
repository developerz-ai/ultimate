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
/**
 * Two ways a budget goes unweighed, and they are not one instruction.
 *
 * `undefined` stats is "no build has ever run in this repo" — one command closes every route at
 * once, and `.x/` is gitignored, so this is the state a fresh clone and a fresh scaffold are in.
 * A stats file that exists and has no row for this route is the other thing entirely: a build DID
 * run and could not weigh this one, which is `PrerenderReport.unmeasured`'s question and not a
 * second build's. Reporting the first as the second is what sends a reader to re-run a build that
 * already did everything it was going to do.
 */
function unmeasuredFinding(url: string, declared: string, built: boolean): Finding {
  return {
    code: 'X_BUDGET_UNMEASURED',
    cause: built
      ? `${url} declares a ${declared} budget and ${BUILD_STATS_FILE} has no row for it, so the build ran and could not weigh it`
      : `${url} declares a ${declared} budget and no build has written ${BUILD_STATS_FILE} in this repo`,
    // `--target static` is load-bearing and `x build` alone was a fix that changes nothing: the
    // flag defaults to `docker`, and only the static target runs `apps/web/prerender.ts`, which is
    // the one caller of `writeBuildStats`. When a build already ran, the second half is where the
    // answer is — the report names every route it could not weigh, and why.
    fix: built
      ? `x build --target static --json   # its "unmeasured" list says why ${url} could not be weighed`
      : 'x build --target static --json && x verify --json',
    docs: 'https://ultimate.dev/errors/X_BUDGET_UNMEASURED',
    at: url,
  };
}

/**
 * `undefined` stats means no build has run; `{ routes: [] }` means one ran and emitted nothing.
 * The parameter is widened rather than defaulted, because collapsing the two here is exactly the
 * distinction the finding above exists to make.
 */
export function checkBudgets(
  manifest: Manifest,
  stats: BuildStats | undefined,
): readonly Finding[] {
  const byPath = new Map((stats?.routes ?? []).map((route) => [route.path, route]));
  const findings: Finding[] = [];
  for (const route of manifest.routes) {
    const measured = byPath.get(route.url);
    const js = jsBudgetOf(route);
    const lcp = route.budget?.lcp;
    if (measured === undefined) {
      if (js !== null || lcp !== undefined) {
        findings.push(unmeasuredFinding(route.url, declaredBudgets(js, lcp), stats !== undefined));
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
 * An island's chunk is reached by `import()` from inside the hydration runtime, so it never appears
 * as a `<script src>` — and a document weighed by script tags alone was charged for the runtime and
 * never for the code that runtime boots. The entry attribute is that module URL, so it is read as
 * exactly what it is: a file the browser will execute.
 */
const ENTRY_ATTR = /\sdata-x-entry="(?<url>[^"]*)"/g;

/** One executable module the document names, and what it weighs on disk. */
export interface MeasuredEntry {
  readonly url: string;
  readonly bytes: number;
}

export interface MeasuredJs {
  readonly jsBytes: number;
  /** Every `src=`/`data-x-entry=` module, so a finding can name the heaviest by file. */
  readonly entries: readonly MeasuredEntry[];
}

/**
 * What a rendered document actually makes the browser execute: the bytes of every inline script,
 * the size of every file a `src` points at, and the size of every island chunk it boots. Measured
 * from the emitted HTML rather than from the declared graph, because the graph is what a route
 * *says* it ships and this gate exists to catch the case where those two disagree.
 */
export async function measureDocumentJs(html: string, out: string): Promise<MeasuredJs> {
  let jsBytes = 0;
  const entries: MeasuredEntry[] = [];
  const weigh = async (url: string): Promise<void> => {
    // Only a path inside the artifact can be weighed; a cross-origin script is not this build's.
    if (!url.startsWith('/')) return;
    const file = Bun.file(join(out, url.slice(1)));
    const bytes = (await file.exists()) ? file.size : 0;
    entries.push({ url, bytes });
    jsBytes += bytes;
  };

  for (const match of html.matchAll(SCRIPT_TAG)) {
    const src = SRC_ATTR.exec(match.groups?.['attrs'] ?? '')?.groups?.['src'];
    if (src === undefined) {
      jsBytes += Buffer.byteLength(match.groups?.['body'] ?? '', 'utf8');
      continue;
    }
    await weigh(src);
  }
  // Deduped: two instances of one island are two wrappers and one chunk, and a browser that
  // imports the same module twice fetches and executes it once.
  const booted = new Set<string>();
  for (const match of html.matchAll(ENTRY_ATTR)) {
    const url = match.groups?.['url'];
    if (url === undefined || booted.has(url)) continue;
    booted.add(url);
    await weigh(url);
  }
  return { jsBytes, entries };
}

/** The total alone, for a caller with nothing to say about which module was the heavy one. */
export async function measureJsBytes(html: string, out: string): Promise<number> {
  return (await measureDocumentJs(html, out)).jsBytes;
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
