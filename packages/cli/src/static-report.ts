// The inventory of one `x build --target static`: which declared route reached the artifact, which
// did not, and WHY for each. Written by the prerenderer, read back by `x build`, so both renderers
// state the same thing. A skipped route with no reason is what turned "the island did not mount"
// into a bug report about a page that had never been in `.x/static/` at all (#242).

// `node:` twice, and only where Bun answers nothing: Bun ships no path API, and `rm(…, { force })`
// deletes a report that may not be there without a branch. `existsSync` was a third and is gone —
// `Bun.file(path).json()` already rejects on a missing file, into the catch that answers `undefined`.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RenderMode } from '@ultimat3/core';
import { RENDER_MODES } from '@ultimat3/core';
import type { Surface } from '@ultimat3/render';
import { SURFACE_SPECS, SURFACES, surfaceAllows } from '@ultimat3/render';
import type { JsonValue } from './output';
import { SERVICE_WORKER_PATH } from './sw-artifacts';

/** Beside `.x/build-stats.json`, and written by the same call — see `readStaticReport` below. */
export const STATIC_REPORT_FILE = join('.x', 'static-report.json');

export const SKIP_REASONS = [
  'surface-forbids-static',
  'mode-revalidates',
  'mode-per-request',
  'no-prerender-paths',
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * Type ALIASES, never interfaces — every shape below is JSON on both sides of a file, and only an
 * alias carries the implicit index signature that makes it assignable to `JsonValue`. As
 * interfaces, `data: { emitted, skipped }` in `cmd-build.ts` was TS2322 (`not assignable to type
 * 'JsonValue'`) with nothing wrong in either file, and the obvious fixes — a cast, a widened
 * annotation — are the two this repo refuses. Same rule `RouteContext` in `@ultimat3/render` is an
 * alias for.
 */

/** The two declarations a skip decision reads. Narrower than `RouteEntry` so a test can state one. */
export type RouteFacts = {
  readonly surface: Surface;
  readonly render: RenderMode;
};

export type SkippedRoute = RouteFacts & {
  /** The DECLARED path, `/blog/:slug` — never a filled one, so the author can grep for it. */
  readonly route: string;
  readonly reason: SkipReason;
  readonly why: string;
};

/**
 * A route that declared a budget and could not be rendered here, and what stopped it.
 *
 * Declared HERE and not in `prerender.ts`, though `prerenderSite` is what fills it: this file is
 * the report's shape and `prerender.ts` imports it, so the other direction is a cycle. `prerender`
 * re-exports the name for its own callers.
 */
export type UnmeasuredRoute = {
  /** The DECLARED path, as `X_BUDGET_UNMEASURED`'s `at:` spells it, so the two rows join. */
  readonly path: string;
  readonly reason: string;
};

/** One HTML file in the artifact, and the declared route that produced it. */
export type EmittedPage = {
  readonly route: string;
  readonly path: string;
  /** Relative to the build output root, POSIX — the file a screenshot tool actually opens. */
  readonly file: string;
};

export type StaticReport = {
  readonly target: 'static';
  readonly out: string;
  readonly buildId: string;
  readonly emitted: readonly EmittedPage[];
  readonly skipped: readonly SkippedRoute[];
  /**
   * Every budgeted route this build could not weigh, with the reason. `X_BUDGET_UNMEASURED`'s own
   * `fix:` cites this list by name — `x build --target static --json # its "unmeasured" list says
   * why` — and until it was written here the list existed only on the in-process `PrerenderReport`
   * and reached no `x` command's output at all: `cmd-build.ts` discards a successful subprocess's
   * stdout. A `fix:` naming a key nothing prints is axiom 4 inverted at the step meant to unblock
   * the reader.
   */
  readonly unmeasured: readonly UnmeasuredRoute[];
  /**
   * The service worker's own findings: a capability declared with nothing to wire it to, and a
   * precache manifest over its byte ceiling. `PrecacheManifest.warnings` had no reader anywhere in
   * the tree (#390), so the ceiling was — in `wiki/Troubleshooting.md`'s own words — "a designed
   * thing that is not one". Written here for `unmeasured`'s reason: `cmd-build.ts` discards a
   * successful subprocess's stdout, so a warning that lives only on the in-process report reaches
   * nobody. Empty for an app with no service worker.
   */
  readonly serviceWorkerWarnings: readonly string[];
};

/**
 * The ONE decision about what lands on a CDN — `isPrerenderable` is derived from it, so the answer
 * and the reason can never disagree.
 *
 * Surface is asked FIRST, and that ordering is the whole finding. `app/` allows `stream | ssr` and
 * nothing else, so no `render:` edit can put an app/ route into the artifact: the surface is the
 * cause, and naming the mode would send an author to change the one thing that cannot help. On a
 * surface that DOES allow `static`, the mode is the cause and the edit is real — which is why the
 * two produce different sentences below rather than one flat "not prerendered".
 */
export function skipReasonFor(route: RouteFacts): SkipReason | null {
  if (!surfaceAllows(route.surface, 'static')) return 'surface-forbids-static';
  if (route.render === 'static') return null;
  return route.render === 'isr' ? 'mode-revalidates' : 'mode-per-request';
}

/**
 * `Object.freeze<Record<…>>`, never `const X: Readonly<Record<…>> = Object.freeze({…})`: the second
 * form infers from the literal and accepts an EXTRA key in silence (`bun run frozen-records`).
 *
 * English rather than `t()`, for the reason every `cause:`/`fix:` in this repo is English: this is
 * a diagnostic an agent pastes into a report, and `wiki/Error-Codes.md` is the same surface.
 */
const WHY = Object.freeze<Record<SkipReason, (route: RouteFacts) => string>>({
  'surface-forbids-static': (route) =>
    `${route.surface}/ surface — server-rendered, not prerendered; ` +
    `${route.surface}/ allows ${SURFACE_SPECS[route.surface].allowedModes.join(' | ') || 'no render mode'}, ` +
    'so no route on it can ever reach the artifact',
  'mode-revalidates': (route) =>
    `render: '${route.render}' regenerates on a tag or ttl and a published file cannot, ` +
    "so it is served by the app — change it to render: 'static' to emit it",
  'mode-per-request': (route) =>
    `render: '${route.render}' is rendered per request, so it is served by the app — ` +
    "change it to render: 'static' to emit it",
  'no-prerender-paths': (route) =>
    `render: '${route.render}' with dynamic params and no prerender() paths, so the build ` +
    'enumerated nothing to write — add prerender() to the route',
});

/** The reason as a row: the code a machine keys off, and the sentence a human reads. */
export function skippedRoute(
  input: RouteFacts & { readonly route: string },
  reason: SkipReason,
): SkippedRoute {
  return {
    route: input.route,
    surface: input.surface,
    render: input.render,
    reason,
    why: WHY[reason](input),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A closed vocabulary, checked against the vocabulary itself. `typeof value === 'string'` is what
 * `surface` and `render` were held to, and a string is not a `Surface`: the parse then handed back
 * a `SkippedRoute` whose declared type says `'site' | 'app' | 'api' | 'shared'` while it holds
 * whatever the file said, so `SURFACE_SPECS[route.surface]` on the read side is `undefined` at the
 * first reader that indexes it. `SKIP_REASONS` was already checked this way; these two are the same
 * kind of field and get the same rule.
 */
const inDomain = (domain: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && domain.includes(value);

const isSkipped = (value: unknown): value is SkippedRoute =>
  isRecord(value) &&
  typeof value['route'] === 'string' &&
  inDomain(SURFACES, value['surface']) &&
  inDomain(RENDER_MODES, value['render']) &&
  typeof value['why'] === 'string' &&
  inDomain(SKIP_REASONS, value['reason']);

const isUnmeasured = (value: unknown): value is UnmeasuredRoute =>
  isRecord(value) && typeof value['path'] === 'string' && typeof value['reason'] === 'string';

const isEmitted = (value: unknown): value is EmittedPage =>
  isRecord(value) &&
  typeof value['route'] === 'string' &&
  typeof value['path'] === 'string' &&
  typeof value['file'] === 'string';

/**
 * Parsed, never cast. The file is this build's own output, but `x build` reads it back off disk
 * after a subprocess — a truncated write or a hand-edit must read as "no report", which the caller
 * already handles, rather than as a report with a `skipped` nobody can render.
 */
export function parseStaticReport(value: unknown): StaticReport | undefined {
  if (!isRecord(value)) return undefined;
  const { target, out, buildId, emitted, skipped, unmeasured, serviceWorkerWarnings } = value;
  if (target !== 'static' || typeof out !== 'string' || typeof buildId !== 'string') {
    return undefined;
  }
  if (!Array.isArray(emitted) || !emitted.every(isEmitted)) return undefined;
  if (!Array.isArray(skipped) || !skipped.every(isSkipped)) return undefined;
  // OPTIONAL on the way in, total on the way out. `.x/` survives a checkout of an older commit,
  // and a report written before this field existed has to read as "nothing unmeasured" — refusing
  // it would answer `X_BUDGET_UNMEASURED` for every route on a build that had weighed them all.
  // Present and malformed is still no report, exactly as a malformed skip row is.
  if (unmeasured !== undefined && (!Array.isArray(unmeasured) || !unmeasured.every(isUnmeasured))) {
    return undefined;
  }
  // Optional on the way in for `unmeasured`'s reason, and a non-string entry drops the whole
  // report for a malformed skip row's reason: a warning list with a hole in it is a build that
  // says less than it measured, which is how the worker's findings went unread in the first place.
  if (
    serviceWorkerWarnings !== undefined &&
    (!Array.isArray(serviceWorkerWarnings) ||
      !serviceWorkerWarnings.every((entry) => typeof entry === 'string'))
  ) {
    return undefined;
  }
  return {
    target,
    out,
    buildId,
    emitted,
    skipped,
    unmeasured: unmeasured ?? [],
    serviceWorkerWarnings: (serviceWorkerWarnings as readonly string[] | undefined) ?? [],
  };
}

export async function writeStaticReport(root: string, report: StaticReport): Promise<string> {
  const path = join(root, STATIC_REPORT_FILE);
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/**
 * `undefined` means no report — an app whose `apps/web/prerender.ts` does not call `prerenderSite`.
 * That app also writes no `.x/build-stats.json` (one call writes both), so `x verify`'s `budgets`
 * step already reds it with `X_BUDGET_UNMEASURED`; this side stays quiet rather than adding a
 * second code for one cause.
 */
export async function readStaticReport(root: string): Promise<StaticReport | undefined> {
  try {
    return parseStaticReport(await Bun.file(join(root, STATIC_REPORT_FILE)).json());
  } catch {
    return undefined;
  }
}

/** Deleted before the builder is spawned, so a failed build can never report the last one's list. */
export async function removeStaticReport(root: string): Promise<void> {
  await rm(join(root, STATIC_REPORT_FILE), { force: true });
}

/**
 * The `--json` half, beside `renderStaticReport`'s human one — and a `Record<string, JsonValue>`
 * rather than a `JsonValue`, because `x build` SPREADS it into `data` beside `target` and
 * `artifact`: a bare `JsonValue` admits a string, so the spread is TS2698 (`spread types may only
 * be created from object types`) and no annotation at the call site can rescue it.
 *
 * A field the compiler cannot prove is JSON reds HERE, at the projection, rather than at whichever
 * caller happens to hand the report to a renderer.
 */
export function staticReportData(report: StaticReport | undefined): Record<string, JsonValue> {
  // Never `{ ...report }`: `out` is an absolute build path and `buildId` is this run's, neither of
  // which the inventory is about — `data` already carries `artifact` and the build's own id.
  return report === undefined
    ? {}
    : {
        emitted: report.emitted,
        skipped: report.skipped,
        unmeasured: report.unmeasured,
        serviceWorkerWarnings: report.serviceWorkerWarnings,
      };
}

/**
 * The human half. Fixed-width columns headed by the JSON's own field names, exactly as
 * `renderRouteTable` is — the renderer invents no prose, so `--json` and the terminal cannot drift.
 */
export function renderStaticReport(report: StaticReport): readonly string[] {
  const rows: readonly (readonly string[])[] = [
    ...report.emitted.map((page) => ['emitted', page.route, page.file]),
    ...report.skipped.map((route) => ['skipped', route.route, route.why]),
    // The same three columns, so the terminal and `--json` carry the same three lists. A route
    // whose budget could not be weighed is invisible in `emitted` and, when it also rendered, in
    // `skipped` too — and it is the row `X_BUDGET_UNMEASURED` sends its reader here to read.
    ...report.unmeasured.map((route) => ['unmeasured', route.path, route.reason]),
    // The service worker's own findings, in the same three columns — a precache manifest over its
    // byte ceiling AND a capability declared with nothing to wire it to, which is why neither the
    // field nor this label says `precache`. `sw.js` is the one artifact that keeps serving after a
    // deploy is over, so both are build-time facts that have to be visible in the build's own
    // output — `PrecacheManifest` computed the first and nothing read it (#390).
    ...report.serviceWorkerWarnings.map((warning) => [
      'service-worker',
      SERVICE_WORKER_PATH,
      warning,
    ]),
  ];
  const widths = [0, 1].map((index) =>
    Math.max(...rows.map((row) => (row[index] ?? '').length), 0),
  );
  return rows.map((row) =>
    `  ${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')}`.trimEnd(),
  );
}
