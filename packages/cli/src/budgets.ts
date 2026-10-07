// Per-route budgets. A blown budget is a build failure, not a Lighthouse report nobody read —
// and the finding names the import chain that caused it, because "your bundle got bigger" is not
// an actionable message for a human or an agent.
//
// Byte parsing and formatting come from `@ultimat3/render`, which owns the budget vocabulary the
// routes are declared in. The one thing that lives here is the comparison against MEASURED bytes:
// render checks a bundle graph, this checks what the build actually emitted.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_DOCS_URL, formatBytes } from '@ultimat3/core';
import type { Manifest, RouteFact } from '@ultimat3/manifest';
import { describePages, parseByteBudget, themeScriptBody } from '@ultimat3/render';
import type { ChargedFile } from './budgets-charged';
import { chargedClause, chargedMeta, heaviestFirst } from './budgets-charged';
import {
  artifactPath,
  carriesJson,
  ENTRY_ATTR,
  loadedBy,
  SCRIPT_TAG,
  SRC_ATTR,
} from './budgets-scan';
import { builtUnmeasuredFinding } from './budgets-unmeasured';
import type { Finding } from './output';
import type { UnmeasuredRoute } from './static-report';
import { SW_REGISTER_PATH } from './sw-artifacts';

export const BUILD_STATS_FILE = join('.x', 'build-stats.json');

export interface RouteStats {
  /**
   * The route's DECLARED path — `/blog/:slug`, never `/blog/hello`. `checkBudgets` looks a row up
   * by `route.url` off the manifest, which is the pattern, so a row keyed by a filled path is a
   * row nothing can find: every dynamic static route read as `X_BUDGET_UNMEASURED`. A route that
   * prerenders many pages contributes ONE row, holding its heaviest.
   */
  readonly path: string;
  /** The APP's JavaScript, and only the app's — see `FRAMEWORK_SCRIPTS`. */
  readonly jsBytes: number;
  /**
   * The framework's own injected runtime, in bytes: reported, never budgeted. Optional because a
   * stats file written before 2026-09-11 has no such key, and absent is not zero — a row from an
   * older build simply did not count it, and `checkBudgets` reads `jsBytes` either way.
   */
  readonly frameworkJsBytes?: number;
  /** Import chain that pulled the heaviest module into this route. */
  readonly heaviestChain?: readonly string[];
  /**
   * Every app file `jsBytes` charged, heaviest first, at the URL the browser fetches. Optional
   * for `frameworkJsBytes`' reason: a row from an older build has none, and absent is not empty.
   */
  readonly charged?: readonly ChargedFile[];
  /** The app's inline script bytes inside `jsBytes` — the part no file in `charged` accounts for. */
  readonly inlineJsBytes?: number;
}

export interface BuildStats {
  readonly routes: readonly RouteStats[];
  /** The measurement rules that wrote the file — `BUILD_STATS_RULES` at the time. */
  readonly measuredBy?: number;
  /** Set by `readBuildStats` on a file an earlier rule wrote: there are no numbers to read. */
  readonly stale?: true;
}

/**
 * The version of the rules `measureDocumentJs` measures by. BUMP IT whenever what is charged
 * changes — a script exempted, a kind of tag excluded — so every stats file written under the old
 * rule stops being read as a measurement. `.x/` survives across framework upgrades, and
 * `examples/dummy` was charged 250 B for `/x-sw-register.js` by a file written before
 * `FRAMEWORK_SCRIPTS` exempted it. `2`: that exemption and the page-boot decision (ledger #28).
 * `3`: an island entry's imported chunks are charged, each once per document (shared chunks).
 * `4`: the exempt theme script's bytes moved — it also stamps `data-theme-default` (plan 101, 09).
 * `5`: a URL is weighed at the path a browser resolves it to (`\` is `/`, `//host` is another
 * origin), so two spellings of one fetch are charged once; and an app/ page is weighed as SERVED
 * — its page boot charged, the runtime chunk that boot makes unfetched not (plan 101 sweep 9).
 */
export const BUILD_STATS_RULES = 5;

const chainOf = (stats: RouteStats): string =>
  stats.heaviestChain === undefined ? 'unknown import chain' : stats.heaviestChain.join(' -> ');

const jsBudgetOf = (route: RouteFact): number | null => parseByteBudget(route.budget?.js);

/** Which file declares a route, by URL — the loaded app's route table, read when the step runs. */
export type RouteFileOf = (url: string) => string | undefined;

const declaredFileOf: RouteFileOf = (url) =>
  describePages().find((route) => route.path === url && route.mount === undefined)?.file;

const KB = 1024;

/**
 * The paste, not the advice: the file, the literal to set (the measured bytes rounded UP to a
 * whole kb, so the raise is the smallest that clears) and the comment `bun run budget-raises`
 * reads above it. The other way out stays beside it — a raise is axiom 9's to allow, not to force.
 */
function exceededJsFix(url: string, file: string | undefined, bytes: number): string {
  const where = file ?? `the file declaring ${url}`;
  const kb = Math.ceil(bytes / KB);
  return `edit ${where} — set budget: { js: '${String(kb)}kb' } with // measured: ${String(bytes)} B (x build --target static) — why: <the function it buys> directly above it; or x routes --json for the chain and move the heavy import behind hydrate: 'interaction'`;
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
function unmeasuredFinding(
  url: string,
  declared: string,
  stats: BuildStats | undefined,
  unmeasured: readonly UnmeasuredRoute[],
): Finding {
  if (stats?.stale === true) {
    return {
      code: 'X_BUDGET_UNMEASURED',
      cause: `${url} declares a ${declared} budget and ${BUILD_STATS_FILE} was written by an earlier measurement rule than this gate's (v${String(BUILD_STATS_RULES)}), so its numbers are not this gate's to read`,
      fix: 'x build --target static --json && x verify --json',
      docs: ERROR_DOCS_URL,
      at: url,
    };
  }
  // A build ran: the report's account of this route decides the instruction
  // (`budgets-unmeasured.ts`) — its own code, an actor edit, or the report.
  if (stats !== undefined) {
    const entry = unmeasured.find((one) => one.path === url);
    return builtUnmeasuredFinding(url, declared, BUILD_STATS_FILE, entry);
  }
  return {
    code: 'X_BUDGET_UNMEASURED',
    cause: `${url} declares a ${declared} budget and no build has written ${BUILD_STATS_FILE} in this repo`,
    // `--target static` is load-bearing and `x build` alone was a fix that changes nothing: the
    // flag defaults to `docker`, and only the static target runs `apps/web/prerender.ts`, which is
    // the one caller of `writeBuildStats`.
    fix: 'x build --target static --json && x verify --json',
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
 * `REPORTED_BY_OWN_CODE` (`budgets-unmeasured.ts`) is reported under that code, with the build's own cause and fix.
 *
 * `fileOf` names the file an `X_BUDGET_EXCEEDED` fix edits: the step runs after the app loaded,
 * so render's route table already holds it. A test hands its own.
 */
export function checkBudgets(
  manifest: Manifest,
  stats: BuildStats | undefined,
  unmeasured: readonly UnmeasuredRoute[] = [],
  fileOf: RouteFileOf = declaredFileOf,
): readonly Finding[] {
  const byPath = new Map((stats?.routes ?? []).map((route) => [route.path, route]));
  // Routes no build can weigh by construction (`UnmeasuredRoute.weighable`): printed by the step,
  // never a finding — an instruction with no edit behind it is noise.
  const unweighable = new Set(
    unmeasured.filter((one) => one.weighable === false).map((one) => one.path),
  );
  const findings: Finding[] = [];
  for (const route of manifest.routes) {
    if (unweighable.has(route.url)) continue;
    const measured = byPath.get(route.url);
    const js = jsBudgetOf(route);
    if (measured === undefined) {
      if (js !== null) {
        findings.push(unmeasuredFinding(route.url, 'JS', stats, unmeasured));
      }
      continue;
    }
    if (js !== null && measured.jsBytes > js) {
      const meta = chargedMeta(measured.jsBytes, measured.charged, measured.inlineJsBytes);
      findings.push({
        code: 'X_BUDGET_EXCEEDED',
        cause: `${route.url} ships ${formatBytes(measured.jsBytes)} of JS (minified, uncompressed) over a ${formatBytes(js)} budget via ${chainOf(measured)}${chargedClause(measured.charged, measured.inlineJsBytes)}`,
        fix: exceededJsFix(route.url, fileOf(route.url), measured.jsBytes),
        docs: ERROR_DOCS_URL,
        at: route.url,
        ...(meta === undefined ? {} : { meta }),
      });
    }
  }
  return findings;
}

export async function readBuildStats(root: string): Promise<BuildStats | undefined> {
  const path = join(root, BUILD_STATS_FILE);
  if (!existsSync(path)) return undefined;
  const read = (await Bun.file(path).json()) as BuildStats;
  // A file the current rules did not write carries no numbers this gate may read.
  return read.measuredBy === BUILD_STATS_RULES ? read : { routes: [], stale: true };
}

/** What `measureDocumentJs` needs beyond the document and the artifact — both for served pages. */
export interface MeasureOptions {
  /**
   * Scripts a document names that the PROCESS serves and the static artifact does not carry, by
   * URL: the page boot (`/_x/page-boot/<id>.js`). Charged like any `<script src>` — ledger #28.
   */
  readonly served?: ReadonlyMap<string, string>;
  /**
   * The page boot's path prefix and the runtime chunks it supplies (#505): on a document carrying
   * the boot an island awaits the runtime the boot installs and never imports the chunk, so the
   * chunk is not charged there. A document without the boot is charged for it as before.
   */
  readonly boot?: { readonly prefix: string; readonly supplies: ReadonlySet<string> };
}

/** Whether a `<script src>` in `html` is the page boot `boot.prefix` names. */
function carriesBoot(html: string, boot: MeasureOptions['boot']): boolean {
  if (boot === undefined) return false;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const src = SRC_ATTR.exec(match.groups?.['attrs'] ?? '')?.groups?.['src'];
    if (src !== undefined && artifactPath(src)?.startsWith(boot.prefix) === true) return true;
  }
  return false;
}

/** One executable module the document names, and what it weighs on disk. */
export interface MeasuredEntry {
  readonly url: string;
  readonly bytes: number;
}

export interface MeasuredJs {
  /** The app's own executable bytes — what `budget.js` is a promise about. */
  readonly jsBytes: number;
  /** The framework's injected runtime, counted separately so it is reported and never charged. */
  readonly frameworkBytes: number;
  /** The app's inline script bytes — the part of `jsBytes` that is not a file in `entries`. */
  readonly inlineBytes: number;
  /** Every APP `src=`/`data-x-entry=` module, so a finding can name the heaviest by file. */
  readonly entries: readonly MeasuredEntry[];
}

/**
 * Scripts the FRAMEWORK injects into a document, which a route's `budget.js` does not answer for.
 * `budget.js` is a promise about the APP's JavaScript: an author can delete an import, move one
 * behind `hydrate: 'interaction'` or drop an island, and can do NOTHING about a file the build
 * writes into every document it renders. Charging it made `js: '0kb'` — the budget `x new`
 * scaffolds on `site/` — unreachable for any installable app, and the `fix:` it printed named an
 * import chain of one entry the author never wrote.
 *
 * It was also not a stable number. `/x-sw-register.js` is written AFTER the documents that name
 * it are weighed (`prerender.ts` emits the worker last, because its precache manifest is built
 * from their content hashes), so a clean `.x/` measured a file that did not exist and recorded 0,
 * and the next build measured the one before it and recorded 250. Same commit, green then red,
 * decided by whether anything had cleaned the output directory.
 *
 * ENUMERATED, and it is one entry — the service-worker register is the only framework
 * `<script src>` EXEMPTED, not the only one emitted. Three framework scripts are deliberately
 * CHARGED. The page boot (plan 101: the page client, the principal fence, the sync target) is
 * framework-emitted too, and charged by decision (DX ledger #28, 2026-09-22): it ships only on a
 * page that hydrates something, so it is part of the interactivity the app opted into, and
 * `examples/dummy`'s route budgets already include it. `render/src/hydrate.ts`'s inline module
 * runtime is charged for the same reason — it exists only when the page ships an island, and a
 * page with a `0kb` budget has none. `island-props.ts`' `<script type="application/json">` is
 * excluded as data, by `carriesJson`, not by this set. A further entry joins this set by a
 * decision, here, with the register's argument: every document carries it and no author can
 * remove it.
 */
export const FRAMEWORK_SCRIPTS: ReadonlySet<string> = new Set([SW_REGISTER_PATH]);

/**
 * The inline bodies the boot puts in EVERY document, keyed by the same argument as
 * `FRAMEWORK_SCRIPTS`: the author cannot edit, delete or move them, so charging one against a
 * `0kb` budget is a finding nobody can act on. Today that is the no-flash theme script, in each
 * of its three fallbacks (`theme-boot.ts` uses `themeScript`'s defaults for everything else, so
 * these are the exact strings a document carries). The hydration runtime is NOT here — it exists
 * only when the page ships an island, and is the cost of the app's own interactivity.
 */
export const FRAMEWORK_INLINE_SCRIPTS: ReadonlySet<string> = new Set(
  (['light', 'dark', 'system'] as const).map((fallback) => themeScriptBody({ fallback })),
);

/**
 * What a rendered document actually makes the browser execute: the bytes of every inline script
 * the parser will run, the size of every file a `src` points at, and the size of every island
 * chunk it boots. A JSON-typed script is skipped — it is data the parser never runs. Measured
 * from the emitted HTML rather than from the declared graph, because the graph is what a route
 * *says* it ships and this gate exists to catch the case where those two disagree.
 */
export async function measureDocumentJs(
  html: string,
  out: string,
  options: MeasureOptions = {},
): Promise<MeasuredJs> {
  let jsBytes = 0;
  let frameworkBytes = 0;
  let inlineBytes = 0;
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
  const served = options.served ?? new Map<string, string>();
  // The runtime chunks this document's page boot makes unfetched: `awaitPageRuntime`'s rule, read
  // the way it reads it — a `<script src>` under the boot's path is in the document.
  const bootSupplied = carriesBoot(html, options.boot) ? (options.boot?.supplies ?? null) : null;
  const weigh = async (named: string): Promise<void> => {
    // Only a path inside the artifact can be weighed; a cross-origin script is not this build's.
    const url = artifactPath(named);
    if (url === undefined || fetched.has(url)) return;
    fetched.add(url);
    // A script the process serves and the artifact does not carry (the page boot) is weighed from
    // the bytes the build holds; everything else from the file the artifact will serve.
    const held = served.get(url);
    const file = Bun.file(join(out, url.slice(1)));
    const exists = held !== undefined || (await file.exists());
    const bytes = held === undefined ? (exists ? file.size : 0) : Buffer.byteLength(held, 'utf8');
    // Counted and set aside, not skipped: the bytes are real and a reader is owed the number.
    // Kept out of `entries` as well as out of `jsBytes`, because `entries` is what a finding reads
    // to name the heaviest import — and on a fresh scaffold every route's `heaviestChain` was
    // `/x-sw-register.js`, a file the author cannot edit, delete or move.
    if (FRAMEWORK_SCRIPTS.has(url)) {
      frameworkBytes += bytes;
      return;
    }
    entries.push({ url, bytes });
    jsBytes += bytes;
    // And every file THAT one loads: an island entry imports its shared chunks (`island-link.ts`),
    // and each is a fetch the browser makes before the island is whole. Through `weigh`, so a chunk
    // two islands share is charged once and a cycle ends at the first repeat.
    if (exists) {
      for (const next of loadedBy(url, held ?? (await file.text()))) {
        if (bootSupplied?.has(next) !== true) await weigh(next);
      }
    }
  };

  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match.groups?.['attrs'] ?? '';
    if (carriesJson(attrs)) continue;
    const src = SRC_ATTR.exec(attrs)?.groups?.['src'];
    if (src === undefined) {
      const body = match.groups?.['body'] ?? '';
      const bytes = Buffer.byteLength(body, 'utf8');
      if (FRAMEWORK_INLINE_SCRIPTS.has(body)) {
        frameworkBytes += bytes;
      } else {
        jsBytes += bytes;
        inlineBytes += bytes;
      }
      continue;
    }
    await weigh(src);
  }
  for (const match of html.matchAll(ENTRY_ATTR)) {
    const url = match.groups?.['url'];
    if (url === undefined) continue;
    await weigh(url);
  }
  return { jsBytes, frameworkBytes, inlineBytes, entries };
}

/**
 * The stats row for one measured document — the ONE place a row is assembled, so the static and
 * the weigh-only branch of the build cannot record different facts about the same kind of page.
 */
export function routeStatsRow(
  path: string,
  measured: MeasuredJs,
  chain: readonly string[] | undefined,
): RouteStats {
  return {
    path,
    jsBytes: measured.jsBytes,
    frameworkJsBytes: measured.frameworkBytes,
    ...(chain === undefined ? {} : { heaviestChain: chain }),
    charged: heaviestFirst(measured.entries),
    inlineJsBytes: measured.inlineBytes,
  };
}

/**
 * The file `checkBudgets` reads. Written by the build and by nothing else — a stats file produced
 * anywhere but from real output is the false green this gate exists to prevent.
 */
export async function writeBuildStats(root: string, stats: BuildStats): Promise<string> {
  const path = join(root, BUILD_STATS_FILE);
  const stamped: BuildStats = { ...stats, measuredBy: BUILD_STATS_RULES };
  await Bun.write(path, `${JSON.stringify(stamped, null, 2)}\n`);
  return path;
}
