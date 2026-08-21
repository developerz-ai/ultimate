// The reason vocabulary, against the real surface table: a `why` that merely EXISTS is not a `why`
// that is correct, and the two causes this pins apart are the two that produced the false bug
// report in #242 — an `app/` route and a non-static `site/` route are not skipped for one reason.

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
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
});

describe('the --json rendering', () => {
  test('carries the inventory and nothing about where this build happened to run', () => {
    // `data` already holds `artifact`; `out` is an absolute path off this machine and `buildId`
    // is this run's — neither is the inventory, and both would be noise an agent diffs on.
    expect(Object.keys(staticReportData(REPORT)).sort()).toEqual(['emitted', 'skipped']);
    expect(staticReportData(REPORT)['emitted']).toEqual(REPORT.emitted);
    expect(staticReportData(REPORT)['skipped']).toEqual(REPORT.skipped);
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
  });
});
