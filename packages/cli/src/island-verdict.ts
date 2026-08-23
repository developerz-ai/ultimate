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
  'cli.shot.island.blind.crop',
  'cli.shot.island.blind.locale',
] as const;

/**
 * What a component picture cannot see, named every time. `errors: 0` read without them is a claim
 * this tool cannot support — and both are properties of the port rather than of a run, which is
 * why they are a constant and not a per-run list.
 *
 * The crop one is the honest limit of the shipped browser port: `CaptureRequest` is `fullPage`
 * alone (`packages/scraping/src/page.ts`), so a picture is the VIEWPORT and the framing knob is the
 * state's own `viewport`, not a clip rectangle. The locale one is the reach of a page-side clock
 * patch: `date.toLocaleString()` resolves the zone inside the engine and never through the patched
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
  readonly box: IslandBox;
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
}

/** One state's picture is clean when nothing on the page logged, threw, or went unanswered. */
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
  ];
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
