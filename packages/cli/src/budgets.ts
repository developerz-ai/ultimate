// Per-route budgets. A blown budget is a build failure, not a Lighthouse report nobody read —
// and the finding names the import chain that caused it, because "your bundle got bigger" is not
// an actionable message for a human or an agent.
//
// Byte parsing and formatting come from `@ultimat3/render`, which owns the budget vocabulary the
// routes are declared in. The one thing that lives here is the comparison against MEASURED bytes:
// render checks a bundle graph, this checks what the build actually emitted.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Manifest, RouteFact } from '@ultimat3/manifest';
import { formatBytes, parseByteBudget } from '@ultimat3/render';
import type { Finding } from './output';
import type { UnmeasuredRoute } from './static-report';

export const BUILD_STATS_FILE = join('.x', 'build-stats.json');

export interface RouteStats {
  /**
   * The route's DECLARED path — `/blog/:slug`, never `/blog/hello`. `checkBudgets` looks a row up
   * by `route.url` off the manifest, which is the pattern, so a row keyed by a filled path is a
   * row nothing can find: every dynamic static route read as `X_BUDGET_UNMEASURED`. A route that
   * prerenders many pages contributes ONE row, holding its heaviest.
   */
  readonly path: string;
  readonly jsBytes: number;
  /**
   * **Written by nothing, `As of 2026-08`.** `apps/web/prerender.ts` is the only producer of this
   * file and it emits static HTML — there is no browser in the build to observe a paint. So the
   * comparison in `checkBudgets` below is reachable only for an app that writes its own stats, and
   * `x new` no longer scaffolds an `lcp` budget for exactly that reason: a budget the build cannot
   * weigh passes silently the moment a stats row exists, which is the false green this file's
   * header is about. `RouteBudget.lcp` still accepts one — that key is `@ultimat3/render`'s.
   */
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
    docs: ERROR_DOCS_URL,
    at: url,
  };
}

/**
 * The ONE code a failed measurement is reported under by its own name rather than as
 * `X_BUDGET_UNMEASURED`. Its cause is complete — the island, the prop, its bytes, the cap — and
 * its fix is an edit to the page, so the step's own "run x build and read the list" would put a
 * second command between the author and a sentence the build had already composed. Every other
 * render failure keeps the generic finding: a `TypeError` from a `load` that wanted a request is
 * a reason to read the report, not an instruction.
 *
 * ONE code and not "any coded error", deliberately. `X_NO_CONTEXT`, `X_UNAUTHENTICATED` and
 * `X_DB_UNAVAILABLE` from a measurement render are facts about the BUILD's environment, and
 * reporting them under their own codes would tell the author to fix a database the gate never
 * had. The list grows by a decision, per code, here.
 */
const REPORTED_BY_OWN_CODE: ReadonlySet<string> = new Set(['X_ISLAND_PROPS_INVALID']);

/**
 * The build's own finding for a route it could not weigh, when that failure is an instruction.
 * Read off the static report's `unmeasured` list — the same list `X_BUDGET_UNMEASURED`'s `fix:`
 * sends its reader to, now read by the step itself for the one code it can act on.
 */
function ownCodeFinding(url: string, unmeasured: readonly UnmeasuredRoute[]): Finding | undefined {
  const entry = unmeasured.find((one) => one.path === url);
  if (entry?.code === undefined || !REPORTED_BY_OWN_CODE.has(entry.code)) return undefined;
  return {
    code: entry.code,
    cause: entry.cause ?? entry.reason,
    fix: entry.fix ?? `x build --target static --json   # its "unmeasured" list has ${url}`,
    docs: ERROR_DOCS_URL,
    at: url,
  };
}

/**
 * `undefined` stats means no build has run; `{ routes: [] }` means one ran and emitted nothing.
 * The parameter is widened rather than defaulted, because collapsing the two here is exactly the
 * distinction the finding above exists to make.
 *
 * `unmeasured` is the static report's list of routes the build rendered and could not weigh, with
 * each failure's code when it had one. Optional because the report is written beside the stats
 * and can be absent for the same reason; with it, a route whose measurement failed on a code in
 * `REPORTED_BY_OWN_CODE` is reported under that code, with the build's own cause and fix.
 */
export function checkBudgets(
  manifest: Manifest,
  stats: BuildStats | undefined,
  unmeasured: readonly UnmeasuredRoute[] = [],
): readonly Finding[] {
  const byPath = new Map((stats?.routes ?? []).map((route) => [route.path, route]));
  const findings: Finding[] = [];
  for (const route of manifest.routes) {
    const measured = byPath.get(route.url);
    const js = jsBudgetOf(route);
    const lcp = route.budget?.lcp;
    if (measured === undefined) {
      if (js !== null || lcp !== undefined) {
        findings.push(
          ownCodeFinding(route.url, unmeasured) ??
            unmeasuredFinding(route.url, declaredBudgets(js, lcp), stats !== undefined),
        );
      }
      continue;
    }
    if (js !== null && measured.jsBytes > js) {
      findings.push({
        code: 'X_BUDGET_EXCEEDED',
        cause: `${route.url} ships ${formatBytes(measured.jsBytes)} of JS (minified, uncompressed) over a ${formatBytes(js)} budget via ${chainOf(measured)}`,
        fix: `x routes --json to see the chain, then move the heavy import behind hydrate: 'interaction'`,
        docs: ERROR_DOCS_URL,
        at: route.url,
      });
    }
    if (lcp !== undefined && measured.lcpMs !== undefined && measured.lcpMs > lcp) {
      findings.push({
        code: 'X_BUDGET_EXCEEDED',
        cause: `${route.url} LCP ${measured.lcpMs}ms over the ${lcp}ms budget`,
        fix: `raise the budget in defineRoute, or switch render to 'isr' to serve it prebuilt`,
        docs: ERROR_DOCS_URL,
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
const TYPE_ATTR = /\stype="(?<type>[^"]*)"/;

/**
 * `application/ld+json`, `application/json`, any `…+json`: the body is data, not code — the rule
 * `@ultimat3/render`'s `head.ts` already states, restated because its `carriesJson` reads a
 * `HeadTag` and is not exported, and this side has an attribute string off the emitted document.
 * Without it a page shipping only `meta.ld` structured data and island props measured 8kb of JS
 * and failed a 2kb budget with a `fix:` naming an import chain that does not exist.
 */
const carriesJson = (attrs: string): boolean => {
  // Everything from the first `;` is a MIME PARAMETER and not the type: a real document writes
  // `type="application/ld+json; charset=utf-8"`, which does not END with `json`, so the suffix
  // test alone charged an SEO structured-data block as executable JavaScript all over again.
  const [type = ''] = (TYPE_ATTR.exec(attrs)?.groups?.['type'] ?? '').split(';');
  return type.trim().toLowerCase().endsWith('json');
};

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
 * What a rendered document actually makes the browser execute: the bytes of every inline script
 * the parser will run, the size of every file a `src` points at, and the size of every island
 * chunk it boots. A JSON-typed script is skipped — it is data the parser never runs. Measured
 * from the emitted HTML rather than from the declared graph, because the graph is what a route
 * *says* it ships and this gate exists to catch the case where those two disagree.
 */
export async function measureDocumentJs(html: string, out: string): Promise<MeasuredJs> {
  let jsBytes = 0;
  const entries: MeasuredEntry[] = [];
  // Deduped ONCE, across both readers below, and the unit is the FETCH: a browser downloads a URL
  // once however many times the document names it, so `budget.js` — a byte budget — counts it
  // once. Two instances of one island are two wrappers and one chunk; so are a `<script src>`
  // repeated by a page and its layout, and a src that is also an island entry. Only the island
  // half was deduped, so a document naming one script twice was charged twice and could fail a
  // budget it clears.
  //
  // EXECUTION is a different count and this is deliberately not it. A repeated classic
  // `<script src>` runs once per element (a module runs once per document, off the module map), so
  // the layout-plus-page case above really does execute twice — for zero extra bytes. That is a
  // CPU cost, and this gate is a bound on what the browser downloads and parses. An INLINE script
  // is not in this set for the same reason: two identical inline bodies are two copies of the
  // bytes in the document, so both are charged.
  const fetched = new Set<string>();
  const weigh = async (url: string): Promise<void> => {
    // Only a path inside the artifact can be weighed; a cross-origin script is not this build's.
    if (!url.startsWith('/') || fetched.has(url)) return;
    fetched.add(url);
    const file = Bun.file(join(out, url.slice(1)));
    const bytes = (await file.exists()) ? file.size : 0;
    entries.push({ url, bytes });
    jsBytes += bytes;
  };

  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match.groups?.['attrs'] ?? '';
    if (carriesJson(attrs)) continue;
    const src = SRC_ATTR.exec(attrs)?.groups?.['src'];
    if (src === undefined) {
      jsBytes += Buffer.byteLength(match.groups?.['body'] ?? '', 'utf8');
      continue;
    }
    await weigh(src);
  }
  for (const match of html.matchAll(ENTRY_ATTR)) {
    const url = match.groups?.['url'];
    if (url === undefined) continue;
    await weigh(url);
  }
  return { jsBytes, entries };
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
