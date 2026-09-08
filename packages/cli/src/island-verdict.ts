// What a run of `x shot --island` CLAIMS, and what it refuses to claim. The route verdict's shape
// extended rather than forked: `ok` is still "nothing logged an error, nothing threw, no mount
// rejected", with the two facts only a component capture has — the requests nobody stubbed, and
// the declared pictures that never landed on disk.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t, validate } from '@ultimat3/schema';
import type { ConsoleLine, PageError } from '@ultimat3/scraping';
import type { IslandShotTarget } from '@ultimat3/testing';
import { msg } from './messages';
import type { JsonValue } from './output';

/** Every key this path renders. `msg()` answers `⟦key⟧` for a miss, which no build can see. */
export const ISLAND_SHOT_MESSAGE_KEYS = [
  'cli.shot.island.ok',
  'cli.shot.island.failed',
  'cli.shot.island.missing',
  'cli.shot.island.picture',
  'cli.shot.island.verdict',
  'cli.shot.island.state',
  'cli.shot.island.index',
  'cli.shot.island.blind.crop',
  'cli.shot.island.blind.locale',
] as const;

/**
 * What a component picture cannot see, named every time. `errors: 0` read without them is a claim
 * this tool cannot support — and both are properties of the port rather than of a run, which is
 * why they are a constant and not a per-run list.
 *
 * The crop one is what a rectangle still cannot see: the picture IS the component's own box now
 * (`clipFor`, `island-shot.ts`), so what a reader loses is the surroundings — a component that
 * overflows its box, or one whose fault is the space around it, is outside the frame. It said the
 * opposite until 2026-08-26 — "the browser port takes no clip rectangle" — which stopped being
 * true when the port gained `CaptureClip`, and a blind spot that names a capability the tool has
 * is the same lie as one that hides a gap. The locale one is the reach of a page-side clock patch:
 * `date.toLocaleString()` resolves the zone inside the engine and never through the patched
 * `Intl.DateTimeFormat`.
 */
export const ISLAND_BLIND_SPOTS = [
  'cli.shot.island.blind.crop',
  'cli.shot.island.blind.locale',
] as const;

export interface IslandBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What `readinessProbe` answers. Parsed, never cast: a page can return anything at all. */
export interface IslandReadiness {
  readonly harness: boolean;
  readonly ready: boolean;
  readonly unstubbed: readonly string[];
  readonly attached: boolean;
  readonly mounted: boolean;
  readonly failed: string | null;
  readonly filled: boolean;
  /** The crop target's rectangle in VIEWPORT coordinates, which is what the DOM answers. */
  readonly box: IslandBox;
  /**
   * The page's scroll offset at the moment the box was measured. A capture clip is in PAGE
   * coordinates, so this is what turns one into the other — and it is a separate field rather than
   * an addition inside the probe because `box` is published in the verdict and means the DOM's own
   * answer there.
   */
  readonly scroll: { readonly x: number; readonly y: number };
  /**
   * Whether the crop target's own content is wider or taller than its box — `scrollWidth >
   * clientWidth` on the element the picture is of. RECORDED, never gating: content spilling out of
   * its box is the single most common ugly-UI symptom and a pixel-tight PNG frequently cannot show
   * it, so a reader needs the fact stated. Gating on it would be gating on a layout opinion.
   */
  readonly overflow: { readonly x: boolean; readonly y: boolean };
  /**
   * The scrollable extent of the document, in PAGE coordinates. The one bound a crop margin can be
   * clamped against: a margin that runs off the page asks CDP to photograph coordinates no content
   * is at, and a rectangle a driver silently resolves is the picture lying about its own subject.
   */
  readonly page: { readonly width: number; readonly height: number };
}

const readinessSchema: StandardSchemaV1<unknown, IslandReadiness> = t.object({
  harness: t.boolean,
  ready: t.boolean,
  unstubbed: t.array(t.string),
  attached: t.boolean,
  mounted: t.boolean,
  failed: t.nullable(t.string),
  filled: t.boolean,
  box: t.object({ x: t.number, y: t.number, width: t.number, height: t.number }),
  scroll: t.object({ x: t.number, y: t.number }),
  overflow: t.object({ x: t.boolean, y: t.boolean }),
  page: t.object({ width: t.number, height: t.number }),
}) as unknown as StandardSchemaV1<unknown, IslandReadiness>;

/**
 * `null` for anything that does not fit, and the caller treats that as "the page answered no
 * probe" — never as a page that is ready. A malformed probe reported as readiness would be the
 * capture asserting nothing while looking like it asserted everything.
 */
export function parseReadiness(value: unknown): IslandReadiness | null {
  const result = validate(readinessSchema, value);
  return result.issues === undefined ? result.value : null;
}

export interface IslandStateShot {
  readonly state: string;
  readonly theme: string;
  /** `<name>/<state>-<theme>.png`, relative to the run's output directory. */
  readonly file: string;
  readonly bytes: number;
  readonly box: IslandBox;
  readonly mounted: boolean;
  readonly unstubbed: readonly string[];
  readonly console: readonly ConsoleLine[];
  readonly pageErrors: readonly PageError[];
  /**
   * The crop target's own overflow at the moment the shutter opened. On `IslandStateShot` and in
   * `--json` because a PNG cannot carry it — and deliberately absent from `stateShotOk` below.
   */
  readonly overflow: { readonly x: boolean; readonly y: boolean };
}

/**
 * Console lines at `warn`. Its own reader rather than a second field: `page.console()` already
 * records every level and `shotJson` already ships the whole array, so a `warnings` array beside
 * `console` would be one fact in two places — what was missing is that nobody COUNTED them.
 */
export const stateShotWarnings = (shot: IslandStateShot): readonly ConsoleLine[] =>
  shot.console.filter((line) => line.level === 'warn');

/**
 * One state's picture is clean when nothing on the page logged an ERROR, threw, or went
 * unanswered. A console WARNING and an overflowing box are recorded beside it and read by neither
 * clause on purpose: a signal that fails a run is a signal an author switches off, and both of
 * these are facts a reviewer judges rather than verdicts a machine can reach.
 */
export const stateShotOk = (shot: IslandStateShot): boolean =>
  shot.mounted &&
  shot.unstubbed.length === 0 &&
  shot.pageErrors.length === 0 &&
  shot.console.every((line) => line.level !== 'error');

export interface IslandVerdictInput {
  readonly island: string;
  readonly name: string;
  readonly server: 'booted' | 'reused';
  readonly capturedAt: string;
  /** Computed BEFORE a browser existed — the complete picture list this run owes. */
  readonly expected: readonly IslandShotTarget[];
  readonly shots: readonly IslandStateShot[];
  /** Declared `target.file`s that are not on disk. The gate the browser cannot influence. */
  readonly missing: readonly string[];
}

export interface IslandVerdict extends IslandVerdictInput {
  readonly ok: boolean;
  readonly blind: readonly string[];
}

export function buildIslandVerdict(input: IslandVerdictInput): IslandVerdict {
  return {
    ...input,
    // The missing list gates on its own, and that is the whole point of computing it from the
    // expansion rather than from what the loop believes it did: a capture that produced nothing
    // and threw nothing would otherwise be a run with no shots, no failures and `ok: true`.
    ok: input.missing.length === 0 && input.shots.every(stateShotOk),
    blind: ISLAND_BLIND_SPOTS.map((key) => msg(key)),
  };
}

const shotJson = (shot: IslandStateShot): JsonValue => ({
  state: shot.state,
  theme: shot.theme,
  file: shot.file,
  bytes: shot.bytes,
  box: { x: shot.box.x, y: shot.box.y, width: shot.box.width, height: shot.box.height },
  mounted: shot.mounted,
  ok: stateShotOk(shot),
  // Counted, never gating — `ok` above is computed without either of them.
  warnings: stateShotWarnings(shot).length,
  overflow: { x: shot.overflow.x, y: shot.overflow.y },
  unstubbed: [...shot.unstubbed],
  console: shot.console.map((line) => ({ level: line.level, text: line.text, at: line.at })),
  pageErrors: shot.pageErrors.map((error) => ({
    message: error.message,
    stack: error.stack ?? null,
    at: error.at,
  })),
});

/** The artifact, and the same object `--json` carries under `data.verdict`. One shape, two files. */
export function islandVerdictJson(verdict: IslandVerdict): JsonValue {
  return {
    ok: verdict.ok,
    island: verdict.island,
    name: verdict.name,
    server: verdict.server,
    capturedAt: verdict.capturedAt,
    expected: verdict.expected.map((target) => target.file),
    missing: [...verdict.missing],
    states: verdict.shots.map(shotJson),
    blind: [...verdict.blind],
  };
}

export interface IslandArtifacts {
  readonly verdict: IslandVerdict;
  /** Absolute path of the directory the pictures and the verdict were written to. */
  readonly dir: string;
  readonly verdictFile: string;
  /** The gallery index, written for a single-island run as well as for a sweep. */
  readonly indexFile: string;
}

export function islandShotLines(artifacts: IslandArtifacts): readonly string[] {
  const verdict = artifacts.verdict;
  return [
    ...verdict.shots.map((shot) =>
      msg('cli.shot.island.state', {
        state: shot.state,
        theme: shot.theme,
        width: shot.box.width,
        height: shot.box.height,
        file: shot.file,
      }),
    ),
    ...verdict.missing.map((file) => msg('cli.shot.island.missing', { file })),
    msg('cli.shot.island.picture', { path: artifacts.dir }),
    msg('cli.shot.island.verdict', { path: artifacts.verdictFile }),
    msg('cli.shot.island.index', { path: artifacts.indexFile }),
  ];
}

export interface IslandSweepArtifacts {
  readonly verdicts: readonly IslandVerdict[];
  /** The island root — every island's own directory sits under it, and so does the index. */
  readonly dir: string;
  readonly indexFile: string;
  readonly ok: boolean;
}

/**
 * The sweep's own lines: one per state per island, every missing picture, then the index. The
 * per-island verdict files are named by the index rather than repeated here — a sweep over twenty
 * islands would otherwise print twenty paths nobody reads before the one that matters.
 */
export function islandSweepLines(artifacts: IslandSweepArtifacts): readonly string[] {
  return [
    ...artifacts.verdicts.flatMap((verdict) => [
      ...verdict.shots.map((shot) =>
        msg('cli.shot.island.state', {
          state: `${verdict.name}/${shot.state}`,
          theme: shot.theme,
          width: shot.box.width,
          height: shot.box.height,
          file: shot.file,
        }),
      ),
      ...verdict.missing.map((file) => msg('cli.shot.island.missing', { file })),
    ]),
    msg('cli.shot.island.picture', { path: artifacts.dir }),
    msg('cli.shot.island.index', { path: artifacts.indexFile }),
  ];
}

/**
 * The same two keys the one-island summary uses, with the island NAMES joined — never a count with
 * a hand-written plural in it, which would be a user-facing string built in code rather than in
 * the catalog. A reader who asked for every island is told which ones there were.
 */
export function islandSweepSummary(artifacts: IslandSweepArtifacts): string {
  const island = artifacts.verdicts.map((verdict) => verdict.name).join(', ');
  const taken = artifacts.verdicts.reduce((total, verdict) => total + verdict.shots.length, 0);
  const expected = artifacts.verdicts.reduce(
    (total, verdict) => total + verdict.expected.length,
    0,
  );
  return artifacts.ok
    ? msg('cli.shot.island.ok', { island, pictures: taken })
    : msg('cli.shot.island.failed', { island, taken, expected });
}

/** The one line a reader sees first, and it names the gating fact rather than the file count. */
export const islandShotSummary = (verdict: IslandVerdict): string =>
  verdict.ok
    ? msg('cli.shot.island.ok', { island: verdict.name, pictures: verdict.shots.length })
    : msg('cli.shot.island.failed', {
        island: verdict.name,
        taken: verdict.shots.length,
        expected: verdict.expected.length,
      });
