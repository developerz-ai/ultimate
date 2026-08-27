// The reason vocabulary, against the real surface table: a `why` that merely EXISTS is not a `why`
// that is correct, and the two causes this pins apart are the two that produced the false bug
// report in #242 — an `app/` route and a non-static `site/` route are not skipped for one reason.

import { afterEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun ships no path API, and `rm(…, { force: true })` removes a fixture
// root that may not exist without a branch.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { RENDER_MODES } from '@ultimat3/core';
import { SURFACE_SPECS, SURFACES, surfaceAllows } from '@ultimat3/render';
import type { StaticReport } from './static-report';
import {
  parseStaticReport,
  readStaticReport,
  removeStaticReport,
  renderStaticReport,
  STATIC_REPORT_FILE,
  skippedRoute,
  skipReasonFor,
  staticReportData,
  writeStaticReport,
} from './static-report';

const ROOT = join(import.meta.dir, '..', '.static-report-fixture');

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('why a route was not prerendered', () => {
  test('a static site/ route is not skipped at all', () => {
    expect(skipReasonFor({ surface: 'site', render: 'static' })).toBeNull();
  });

  test('an app/ route is skipped for its SURFACE, never for its mode', () => {
    // The distinction that matters: `app/` allows only stream|ssr, so no `render:` edit can put an
    // app/ route in the artifact. Naming the mode would send an author to change the one thing
    // that cannot help — and #242's screenshot tool read exactly that kind of answer.
    for (const render of SURFACE_SPECS.app.allowedModes) {
      const facts = { surface: 'app', render } as const;
      expect(skipReasonFor(facts)).toBe('surface-forbids-static');
      const why = skippedRoute({ ...facts, route: '/play' }, 'surface-forbids-static').why;
      expect(why).toContain('app/');
      // The mode is NOT the cause, so the sentence must not offer the edit that cannot work.
      expect(why).not.toContain("use render: 'static'");
    }
  });

  test('a site/ route is skipped for its MODE, and isr differs from ssr', () => {
    const isr = skippedRoute(
      { surface: 'site', render: 'isr', route: '/blog' },
      skipReasonFor({ surface: 'site', render: 'isr' }) ?? 'mode-per-request',
    );
    const ssr = skippedRoute(
      { surface: 'site', render: 'ssr', route: '/search' },
      skipReasonFor({ surface: 'site', render: 'ssr' }) ?? 'mode-per-request',
    );
    expect(isr.reason).toBe('mode-revalidates');
    expect(ssr.reason).toBe('mode-per-request');
    // Two different causes, so two different sentences — a flat string collapsing them is what
    // produces the next false bug report.
    expect(isr.why).not.toBe(ssr.why);
    expect(isr.why).toContain('isr');
    expect(ssr.why).toContain('ssr');
    // Both are on a surface that CAN be static, so both name the edit that works.
    expect(isr.why).toContain("render: 'static'");
    expect(ssr.why).toContain("render: 'static'");
  });

  test('every surface × mode pair has an answer, and it agrees with the surface table', () => {
    for (const surface of SURFACES) {
      for (const render of RENDER_MODES) {
        const reason = skipReasonFor({ surface, render });
        // Prerenderable iff the surface allows static AND the route declared it. Derived from
        // `@ultimat3/render`'s own table rather than from a second list of surfaces here.
        const prerenderable = surfaceAllows(surface, 'static') && render === 'static';
        expect(reason === null).toBe(prerenderable);
        if (reason !== null) {
          expect(skippedRoute({ surface, render, route: '/x' }, reason).why.length).toBeGreaterThan(
            20,
          );
        }
      }
    }
  });

  test('a static route that enumerated no paths is skipped, not vanished', () => {
    // `enumeratePrerender` answers `[]` for a dynamic route with no `prerender()`, so a
    // `render: 'static'` route with a param emits zero files. Reported, because a route in NEITHER
    // list is the original defect wearing a new shape.
    const skipped = skippedRoute(
      { surface: 'site', render: 'static', route: '/blog/:slug' },
      'no-prerender-paths',
    );
    expect(skipped.why).toContain('prerender()');
    expect(skipped.route).toBe('/blog/:slug');
  });
});

const REPORT: StaticReport = {
  target: 'static',
  out: '/tmp/out',
  buildId: 'abc123',
  emitted: [{ route: '/', path: '/', file: 'index.html' }],
  skipped: [
    {
      route: '/feed',
      surface: 'app',
      render: 'stream',
      reason: 'surface-forbids-static',
      why: 'app/ surface — server-rendered, not prerendered',
    },
  ],
  unmeasured: [
    { path: '/posts/new', reason: 'X_NO_CONTEXT: useContext() outside runWithContext()' },
  ],
  precacheWarnings: ['precache total 6.1 MB exceeds the 5 MB budget'],
};

describe('the report on disk', () => {
  test('round-trips, and a stale one can be removed before the next build', async () => {
    const path = await writeStaticReport(ROOT, REPORT);
    expect(path).toBe(join(ROOT, STATIC_REPORT_FILE));
    expect(await readStaticReport(ROOT)).toEqual(REPORT);
    await removeStaticReport(ROOT);
    // The guard against reporting a PREVIOUS build's inventory as this one's.
    expect(await readStaticReport(ROOT)).toBeUndefined();
  });

  test('a file that is not a report reads as no report, never as a half-parsed one', async () => {
    await Bun.write(join(ROOT, STATIC_REPORT_FILE), '{"target":"static","emitted":"all of them"}');
    expect(await readStaticReport(ROOT)).toBeUndefined();
    expect(parseStaticReport(null)).toBeUndefined();
    expect(parseStaticReport({ ...REPORT, skipped: [{ route: '/x' }] })).toBeUndefined();
  });

  test('a report naming a surface or a mode that does not exist reads as no report', async () => {
    // The half a `typeof === 'string'` check cannot see. `SkippedRoute.surface` is declared
    // `Surface`, so a parse that admits any string hands every later reader a value its own type
    // says is impossible — `SURFACE_SPECS['sight']` is `undefined`, and the crash lands wherever
    // the first indexer happens to be rather than here, at the file that was already malformed.
    const rowOf = (over: Record<string, unknown>): unknown => ({
      ...REPORT,
      skipped: [{ ...REPORT.skipped[0], ...over }],
    });
    expect(parseStaticReport(rowOf({ surface: 'sight' }))).toBeUndefined();
    expect(parseStaticReport(rowOf({ render: 'STATIC' }))).toBeUndefined();
    expect(parseStaticReport(rowOf({ reason: 'because' }))).toBeUndefined();
    // Not a blanket refusal: every declared member still parses, so a widened vocabulary in
    // `@ultimat3/render` or `@ultimat3/core` reaches this parser without an edit here.
    for (const surface of SURFACES) {
      for (const render of RENDER_MODES) {
        expect(parseStaticReport(rowOf({ surface, render }))).toBeDefined();
      }
    }
  });

  test('a root with no report at all reads as no report, without a stat call of its own', async () => {
    // `existsSync` used to answer this and was redundant: `Bun.file(path).json()` rejects on a
    // missing file into the same catch. Pinned so the branch that replaced it cannot be deleted.
    expect(await readStaticReport(join(ROOT, 'never-built'))).toBeUndefined();
  });
});

describe('the --json rendering', () => {
  test('carries the inventory and nothing about where this build happened to run', () => {
    // `data` already holds `artifact`; `out` is an absolute path off this machine and `buildId`
    // is this run's — neither is the inventory, and both would be noise an agent diffs on.
    expect(Object.keys(staticReportData(REPORT)).sort()).toEqual([
      'emitted',
      'precacheWarnings',
      'skipped',
      'unmeasured',
    ]);
    expect(staticReportData(REPORT)['emitted']).toEqual(REPORT.emitted);
    expect(staticReportData(REPORT)['skipped']).toEqual(REPORT.skipped);
    // The list `X_BUDGET_UNMEASURED`'s own `fix:` cites by name. It was computed by
    // `prerenderSite`, returned on `PrerenderReport` and reached NO output surface any `x` command
    // produced — `cmd-build.ts` discards a successful subprocess's stdout — so an author who ran
    // the fix verbatim got no `unmeasured` key and no reason. Axiom 4 inverted at the step meant
    // to unblock them.
    expect(staticReportData(REPORT)['unmeasured']).toEqual(REPORT.unmeasured);
    // `PrecacheManifest.warnings` had no reader anywhere in the tree, which is what made the
    // precache ceiling — in `wiki/Troubleshooting.md`'s own words — a designed thing that is not
    // one (#390). `x build --json` is the reader.
    expect(staticReportData(REPORT)['precacheWarnings']).toEqual(REPORT.precacheWarnings);
  });

  test('no report is no keys, never an empty inventory', () => {
    // `x build --target docker` produces no report at all. `{ emitted: [], skipped: [] }` would
    // tell a reader this build prerendered nothing, which is a different claim from not asking.
    expect(staticReportData(undefined)).toEqual({});
  });

  test('survives the serialization it exists for, field for field', () => {
    // The runtime half of the type rule above the declarations: a field that is not JSON
    // (a Date, a Map, an `undefined`) reds `tsc` at `staticReportData` — and if one ever reaches
    // here through a parse, `JSON.stringify` silently changes or drops it. Both halves, because
    // `x build --json` is read by CI and the terminal path renders from the same report.
    const data = staticReportData(REPORT);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});

describe('the human rendering', () => {
  test('names every route in one of the two columns, with the reason beside the skipped ones', () => {
    const lines = renderStaticReport(REPORT).join('\n');
    expect(lines).toContain('emitted');
    expect(lines).toContain('index.html');
    expect(lines).toContain('skipped');
    expect(lines).toContain('/feed');
    // The `why` is the whole point of the human path: `--json` is not the only reader.
    expect(lines).toContain('app/ surface');
    expect(lines).toContain('precache');
    expect(lines).toContain('exceeds the 5 MB budget');
  });

  test('a report written before precacheWarnings existed reads as none, not as unparseable', () => {
    // `.x/` survives a checkout of an older commit, and refusing such a report would answer
    // `X_BUDGET_UNMEASURED` for every route on a build that had weighed them all — the rule
    // `unmeasured` already earned one field earlier.
    const { precacheWarnings: _dropped, ...older } = REPORT;
    expect(parseStaticReport(older)?.precacheWarnings).toEqual([]);
  });

  test('a warning list with a non-string in it is no report, never a half-read one', () => {
    expect(parseStaticReport({ ...REPORT, precacheWarnings: ['ok', 7] })).toBeUndefined();
  });
});

describe('the unmeasured list survives the file it is read back from', () => {
  test('a route the build could not weigh round-trips with its reason', async () => {
    await writeStaticReport(ROOT, REPORT);
    const read = await readStaticReport(ROOT);
    expect(read?.unmeasured).toEqual([
      { path: '/posts/new', reason: 'X_NO_CONTEXT: useContext() outside runWithContext()' },
    ]);
  });

  // Optional on the way IN and total on the way out: `.x/` survives a checkout of an older
  // commit, and a report written before this field existed must read as "nothing unmeasured"
  // rather than as no report at all — which would answer `X_BUDGET_UNMEASURED` for every route
  // on a build that had in fact weighed them.
  test('a report written before the field existed still parses, as an empty list', () => {
    const { unmeasured: _dropped, ...older } = REPORT;
    expect(parseStaticReport(older)?.unmeasured).toEqual([]);
  });

  test('a malformed row is no report, exactly as a malformed skip row is', () => {
    expect(parseStaticReport({ ...REPORT, unmeasured: [{ path: '/x' }] })).toBeUndefined();
    expect(parseStaticReport({ ...REPORT, unmeasured: 'all of them' })).toBeUndefined();
  });
});
