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
  FRAMEWORK_SCRIPTS,
  measureDocumentJs,
  readBuildStats,
  writeBuildStats,
} from './budgets';
import type { PwaArtifacts } from './pwa-artifacts';
import type { StaticReport } from './static-report';
import { staticReportData } from './static-report';
import { SW_REGISTER_PATH, serviceWorkerHead } from './sw-artifacts';

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

  // The unit, pinned: RAW bytes on disk, never a compressed size. A 350 kB library that gzips to
  // 90 kB is 350 kB against the budget, because the number bounds what the browser executes. An
  // app read "compressed" into the docs and could not see why its island never fit (2026-09-05).
  test('a src is weighed at its raw size on disk, not what it would compress to', async () => {
    const compressible = 'var a=1;'.repeat(2_048); // 16 kB of one phrase — gzips to a few hundred
    await Bun.write(join(out, 'repeat.js'), compressible);
    expect(await jsBytesOf('<script src="/repeat.js"></script>', out)).toBe(compressible.length);
    expect(Bun.gzipSync(Buffer.from(compressible)).byteLength).toBeLessThan(
      compressible.length / 8,
    );
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

  // A URL the document names twice is ONE fetch, and `budget.js` is a byte budget — so it is
  // charged once, classic or module. The island half was already deduped through `booted`; the
  // `<script src>` half was not, so a document that named one chunk from two places — a page and
  // its layout, a preload beside the tag that uses it — was charged for it twice and could fail a
  // budget it clears. Two instances of one island are one module, and so are two tags with one src.
  //
  // Both forms are asserted because they differ in EXECUTION and not in bytes: a repeated classic
  // script runs once per element, a repeated module runs once per document. That difference is a
  // CPU cost and this gate weighs what the browser downloads, so the two must agree here — and a
  // test that only covered `type="module"` would leave the case the framework actually emits
  // (`sw-artifacts.ts`'s classic `<script src="/x-sw-register.js">`) unpinned.
  test.each([
    ['classic', '<script src="/twice.js"></script>'],
    ['module', '<script type="module" src="/twice.js"></script>'],
  ])('a %s script the document names twice is charged once', async (_kind, once) => {
    const dir = join(out, `case-${Bun.hash(`twice-${once}`).toString(16)}`);
    await Bun.write(join(dir, 'twice.js'), 'console.log(1)');
    expect(await jsBytesOf(once, dir)).toBe(14);
    expect(await jsBytesOf(`${once}${once}`, dir)).toBe(14);
    // And the entry list names it once, so `heaviestSource` cannot report a duplicate as the
    // heaviest thing on the page.
    expect((await measureDocumentJs(`${once}${once}`, dir)).entries).toEqual([
      { url: '/twice.js', bytes: 14 },
    ]);
  });

  // The two readers are one browser: a chunk reached by `<script src>` and the same URL named as an
  // island entry is still one module fetch.
  test('a src and a data-x-entry naming one url are one module', async () => {
    const dir = join(out, `case-${Bun.hash('both').toString(16)}`);
    await Bun.write(join(dir, 'both.js'), 'console.log(1)');
    const document = '<script src="/both.js"></script><div data-x-entry="/both.js"></div>';
    expect(await jsBytesOf(document, dir)).toBe(14);
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

// -------------------------------------------------------------------------------------------
// `budget.js` is a promise about the APP's JavaScript. The framework injects its own service
// worker registration into EVERY document it renders (`sw-artifacts.ts`'s `serviceWorkerHead`,
// 250 bytes), and charging those bytes to the route made `js: '0kb'` unreachable for any
// installable app — which contradicts what `site/` promises and what `x new` scaffolds.
//
// Measured on a real scaffold, 2026-09-11, and the SECOND face of the defect is worse than the
// first: `/x-sw-register.js` is written AFTER the documents are measured, so build #1 weighed a
// file that did not exist yet and recorded `jsBytes: 0`, and build #2 weighed the one build #1
// left behind and recorded `jsBytes: 250` — the same commit, green then red, decided by whether
// `.x/` had been cleaned. A gate whose verdict depends on run order is not a gate.
// -------------------------------------------------------------------------------------------
describe("unit · the framework-injected runtime is not the app's JS", () => {
  const root = join(tmpdir(), 'x-budget-framework');
  const registration = '<script src="/x-sw-register.js" defer></script>';

  /** An installable app, as `loadPwaArtifacts` resolves one. `fallback` is what emits the tag. */
  const PWA: PwaArtifacts = {
    body: '{}',
    head: '',
    offline: { fallback: '/offline', image: null, font: null, neverCache: [] },
    backgroundSync: false,
    push: false,
  };

  const withRegistration = async (): Promise<string> => {
    const dir = join(root, `case-${Bun.hash('sw-register').toString(16)}`);
    await Bun.write(join(dir, 'x-sw-register.js'), 'r'.repeat(250));
    return dir;
  };

  test('the path excluded is the one sw-artifacts.ts emits, not a literal typed twice', () => {
    expect([...FRAMEWORK_SCRIPTS]).toEqual([SW_REGISTER_PATH]);
    expect(serviceWorkerHead(PWA)).toBe(`<script src="${SW_REGISTER_PATH}" defer></script>`);
  });

  test("its bytes are not the route's jsBytes", async () => {
    expect(await jsBytesOf(registration, await withRegistration())).toBe(0);
  });

  // Reported, never folded in silently: the bytes exist and a reader is owed the number.
  test('they are reported under their own name instead', async () => {
    const measured = await measureDocumentJs(registration, await withRegistration());
    expect(measured.frameworkBytes).toBe(250);
  });

  // `heaviestChain` named `/x-sw-register.js` as the app's heaviest import on every route of a
  // fresh scaffold — a `fix:` pointing at a file the author did not write and cannot remove.
  test('and it is not an entry, so no finding can name it as the heaviest import', async () => {
    expect((await measureDocumentJs(registration, await withRegistration())).entries).toEqual([]);
  });

  // The app's own scripts are untouched by the exclusion — the half that would make this a hole.
  test('an app script in the same document is still charged in full', async () => {
    const dir = join(root, `case-${Bun.hash('sw-plus-app').toString(16)}`);
    await Bun.write(join(dir, 'x-sw-register.js'), 'r'.repeat(250));
    await Bun.write(join(dir, 'app.js'), 'console.log(1)');
    const measured = await measureDocumentJs(
      `${registration}<script type="module" src="/app.js"></script>`,
      dir,
    );
    expect(measured.jsBytes).toBe(14);
    expect(measured.frameworkBytes).toBe(250);
    expect(measured.entries).toEqual([{ url: '/app.js', bytes: 14 }]);
  });

  // The gate's end of it: the row a build now writes for a `site/` page of an installable app.
  test('a 0kb route carrying only the registration passes the gate', () => {
    const findings = checkBudgets(
      manifestOf(route('/', { js: '0kb' })),
      stats({ path: '/', jsBytes: 0, frameworkJsBytes: 250 }),
    );
    expect(findings).toEqual([]);
  });

  // And the app's own bytes still fail it, or the exclusion has eaten the gate.
  test("the same route still fails on one byte of the app's own JS", () => {
    const findings = checkBudgets(
      manifestOf(route('/', { js: '0kb' })),
      stats({ path: '/', jsBytes: 1, frameworkJsBytes: 250 }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_EXCEEDED']);
  });
});
