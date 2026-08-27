// The budget gate's own contract: a blown budget fails, and — the case this file exists for — a
// declared budget nothing measured fails too. A route that clears `x verify` without ever being
// weighed is the false green axiom 5 forbids.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { RouteFact } from '@ultimat3/manifest';
import { buildManifest } from '@ultimat3/manifest';
import type { BuildStats } from './budgets';
import {
  BUILD_STATS_FILE,
  checkBudgets,
  measureDocumentJs,
  readBuildStats,
  writeBuildStats,
} from './budgets';
import type { StaticReport } from './static-report';
import { staticReportData } from './static-report';

const manifestOf = (...routes: readonly RouteFact[]) =>
  buildManifest({ app: { name: 'fixture', version: '1.0.0' }, routes });

const route = (url: string, budget?: RouteFact['budget']): RouteFact => ({
  url,
  render: 'static',
  ...(budget === undefined ? {} : { budget }),
});

const stats = (...routes: BuildStats['routes']): BuildStats => ({ routes });

/** The shape `x build --target static --json` spreads into `data` — what the `fix:` promises. */
const EMPTY_REPORT: StaticReport = {
  target: 'static',
  out: '/app/.x/static',
  buildId: 'b1',
  emitted: [],
  skipped: [],
  unmeasured: [],
  serviceWorkerWarnings: [],
};

/**
 * The total alone. It was `budgets.ts`'s own `measureJsBytes` export, whose doc named "a caller
 * with nothing to say about which module was the heavy one" — and the only caller it ever had was
 * this file. A one-line projection belongs beside its one reader.
 */
const jsBytesOf = async (html: string, out: string): Promise<number> =>
  (await measureDocumentJs(html, out)).jsBytes;

describe('unit · budgets', () => {
  test('a declared JS budget with no measurement is a finding, not a pass', () => {
    const findings = checkBudgets(manifestOf(route('/pricing', { js: '20kb' })), undefined);
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_UNMEASURED']);
    expect(findings[0]?.cause).toContain('/pricing');
    expect(findings[0]?.cause).toContain('JS');
    expect(findings[0]?.cause).toContain(BUILD_STATS_FILE);
    expect(findings[0]?.fix).toBe('x build --target static --json && x verify --json');
    expect(findings[0]?.at).toBe('/pricing');
  });

  // Two conditions, two instructions. "No build has run" is closed by one command for every route
  // at once; "a build ran and has no row for this one" is not closed by running it again — the
  // report's own `unmeasured` list is where that answer is. One cause for both sent a reader to
  // re-run a build that had already done everything it was going to do.
  test('a build that ran and missed the route says so, and does not ask for a rebuild alone', () => {
    const built = checkBudgets(manifestOf(route('/pricing', { js: '20kb' })), stats());
    expect(built[0]?.cause).toContain('the build ran and could not weigh it');
    // NOT `toContain('unmeasured')`, which is what this asserted while the list did not exist:
    // the word appeared in the fix line, `x build --target static --json` printed no such key, and
    // an author who ran the instruction verbatim got nothing. The key the fix NAMES is resolved
    // out of the fix itself and looked up in what that command really prints.
    const named = /"([a-z]+)" list/.exec(built[0]?.fix ?? '')?.[1];
    // The fix line naming no list at all is the same defect as it naming the wrong one, so it is a
    // failure here rather than a `?? ''` that would make the lookup below ask about an empty key.
    if (named === undefined) expect.unreachable('the fix line names no report list');
    expect(named).toBe('unmeasured');
    expect(Object.keys(staticReportData(EMPTY_REPORT))).toContain(named);
    const never = checkBudgets(manifestOf(route('/pricing', { js: '20kb' })), undefined);
    expect(never[0]?.cause).toContain('no build has written');
    expect(never[0]?.fix).toBe('x build --target static --json && x verify --json');
    expect(built[0]?.cause).not.toBe(never[0]?.cause);
  });

  test('a declared LCP budget with no measurement is a finding too', () => {
    const findings = checkBudgets(manifestOf(route('/slow', { lcp: 1200 })), undefined);
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_UNMEASURED']);
    expect(findings[0]?.cause).toContain('LCP');
    expect(findings[0]?.cause).not.toContain('JS');
  });

  test('both budgets unmeasured is one finding that names both', () => {
    const findings = checkBudgets(manifestOf(route('/both', { js: '5kb', lcp: 900 })), undefined);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('JS and LCP');
  });

  test('a route that declares no budget and was never measured is not a finding', () => {
    expect(checkBudgets(manifestOf(route('/about')), undefined)).toEqual([]);
  });

  test('a measured route over its JS budget names the import chain that caused it', () => {
    const findings = checkBudgets(
      manifestOf(route('/dash', { js: '10kb' })),
      stats({ path: '/dash', jsBytes: 40_000, heaviestChain: ['/dash', 'chart.ts'] }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_EXCEEDED']);
    expect(findings[0]?.cause).toContain('/dash -> chart.ts');
  });

  test('a measured route inside both budgets passes', () => {
    const findings = checkBudgets(
      manifestOf(route('/dash', { js: '10kb', lcp: 1500 })),
      stats({ path: '/dash', jsBytes: 1_000, lcpMs: 900 }),
    );
    expect(findings).toEqual([]);
  });

  test('a measured route over its LCP budget fails on LCP alone', () => {
    const findings = checkBudgets(
      manifestOf(route('/dash', { lcp: 1000 })),
      stats({ path: '/dash', jsBytes: 0, lcpMs: 2400 }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_EXCEEDED']);
    expect(findings[0]?.cause).toContain('2400ms');
  });
});

describe('unit · measureJsBytes weighs the document, not the graph', () => {
  const out = join(tmpdir(), 'x-budget-measure');

  test('a page with no script ships no JS, measured rather than assumed', async () => {
    expect(await jsBytesOf('<html><body><h1>hi</h1></body></html>', out)).toBe(0);
  });

  test('an inline script counts its own bytes', async () => {
    expect(await jsBytesOf('<script>let a=1</script>', out)).toBe('let a=1'.length);
  });

  test('a src the artifact does not contain contributes nothing it cannot prove', async () => {
    expect(await jsBytesOf('<script src="/missing.js"></script>', out)).toBe(0);
  });

  test('a cross-origin script is not this build`s to weigh', async () => {
    expect(await jsBytesOf('<script src="https://cdn.test/a.js"></script>', out)).toBe(0);
  });

  test('a chunk on disk is weighed at its real size', async () => {
    const dir = join(out, `case-${Bun.hash('chunk').toString(16)}`);
    await Bun.write(join(dir, 'chunk.js'), 'console.log(1)');
    expect(await jsBytesOf('<script src="/chunk.js"></script>', dir)).toBe(14);
  });

  // The bug this guards: a document that makes the browser execute NOTHING failed its JS budget,
  // with a `fix:` telling the author to move an import that does not exist. `@ultimat3/seo` emits
  // `application/ld+json` for structured data and `@ultimat3/render` emits `application/json` for
  // island props — both are data the parser never runs.
  test('a JSON-typed script is data, so a page of only data ships zero JS', async () => {
    const document =
      '<script type="application/ld+json">{"@type":"Article","headline":"a long headline"}</script>' +
      '<script type="application/json" data-x-props="i1">{"title":"another long string"}</script>';
    expect(await jsBytesOf(document, out)).toBe(0);
  });

  // A real document writes the charset: `<script type="application/ld+json; charset=utf-8">` is
  // what a CMS and half the structured-data guides emit, and it does not END with `json` — so the
  // budget charged an SEO block as executable JS again, which is the bug the case above closes.
  test('a MIME parameter does not turn structured data back into code', async () => {
    const withCharset = '<script type="application/ld+json; charset=utf-8">{"a":1}</script>';
    expect(await jsBytesOf(withCharset, out)).toBe(0);
    expect(await jsBytesOf('<script type="application/json;charset=utf-8">1</script>', out)).toBe(
      0,
    );
    // And the parameter cannot make code data: the suffix test still decides, on the type alone.
    expect(
      await jsBytesOf('<script type="text/javascript; charset=utf-8">let a=1</script>', out),
    ).toBe(7);
  });

  test('the rule is the type ending in json, not the one literal type', async () => {
    expect(await jsBytesOf('<script type="importmap+json">{"a":1}</script>', out)).toBe(0);
    expect(await jsBytesOf('<script type="APPLICATION/LD+JSON"> {"a":1} </script>', out)).toBe(0);
    // A module is code, and so is a type nobody declared.
    expect(await jsBytesOf('<script type="module">let a=1</script>', out)).toBe(7);
    expect(await jsBytesOf('<script>let a=1</script>', out)).toBe(7);
  });
});

describe('unit · writeBuildStats is what makes X_BUDGET_UNMEASURED reachable', () => {
  test('round-trips through the path checkBudgets reads', async () => {
    const root = join(tmpdir(), `x-budget-stats-${Bun.hash(import.meta.path).toString(16)}`);
    const written = await writeBuildStats(root, { routes: [{ path: '/', jsBytes: 42 }] });
    expect(written).toEndWith(BUILD_STATS_FILE);
    expect(await readBuildStats(root)).toEqual({ routes: [{ path: '/', jsBytes: 42 }] });
  });

  test('a route the build never wrote stays unmeasured, so the gate reports it', async () => {
    const root = join(tmpdir(), `x-budget-gap-${Bun.hash(`${import.meta.path}gap`).toString(16)}`);
    await writeBuildStats(root, { routes: [{ path: '/', jsBytes: 0 }] });
    const measured = await readBuildStats(root);
    const findings = checkBudgets(
      manifestOf(route('/dash', { js: '40kb' })),
      measured ?? { routes: [] },
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_UNMEASURED']);
  });
});

describe('unit · an ABSENT stats file is every budget unmeasured, not nothing to weigh', () => {
  // The whole per-route half of the `budgets` step was skipped when `.x/build-stats.json` was
  // missing — and `.x/` is gitignored, so it had never run in CI or on either gated app while the
  // step printed a green line. The step now reads `(await readBuildStats(root)) ?? { routes: [] }`,
  // which is exactly the substitution asserted here.
  test('no stats file reports one finding per route that declares a budget', async () => {
    const root = join(
      tmpdir(),
      `x-budget-absent-${Bun.hash(`${import.meta.path}none`).toString(16)}`,
    );
    expect(await readBuildStats(root)).toBeUndefined();
    const manifest = manifestOf(
      route('/', { js: '0kb', lcp: 1200 }),
      route('/dash', { js: '60kb', lcp: 2500 }),
      // A route declaring nothing is still skipped — the rule is "declared but unweighed".
      route('/about'),
    );
    // The step hands `checkBudgets` exactly this — the reader's answer, not a stand-in for it.
    const findings = checkBudgets(manifest, await readBuildStats(root));
    expect(findings.map((finding) => finding.at)).toEqual(['/', '/dash']);
    expect(new Set(findings.map((finding) => finding.code))).toEqual(
      new Set(['X_BUDGET_UNMEASURED']),
    );
    for (const finding of findings)
      expect(finding.fix).toBe('x build --target static --json && x verify --json');
  });

  test('an app that declares no budgets anywhere still passes with no stats file', () => {
    expect(checkBudgets(manifestOf(route('/'), route('/about')), undefined)).toEqual([]);
  });
});
