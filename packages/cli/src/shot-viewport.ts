// `x shot --viewport 390x844,1440x900`: the flag read into sizes, and one route photographed once
// per size into `<out>/<w>x<h>/` over ONE dev server. Every responsive picture used to need a
// hand-written browser script beside the tool that exists to make that unnecessary (#444).

// why: no Bun native joins a path.
import { join } from 'node:path';
import { renderCauseValue } from '@ultimat3/core';
import type { ShotRun } from './cmd-shot';
import { BadFlagError } from './errors';
import type { CommandResult } from './output';
import type { ShotServer } from './shot-server';
import type { ShotArtifacts } from './shot-verdict';
import { shotLines, shotSummary, verdictJson } from './shot-verdict';

/** CSS pixels a page is laid out in. */
export interface ShotViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The largest side a size may have: Chrome's maximum texture dimension, past which a capture is
 * tiles the compositor never painted. One bound for both sides, so the refusal states one number.
 */
export const VIEWPORT_MAX = 16_384;

/** Digits only: `0x10`, `1e3` and `390.5` are not a size anybody typed meaning a size. */
const SIZE = /^(\d+)x(\d+)$/i;

const FIX = 'x shot / --viewport 390x844,1440x900 --json';

const refuse = (reason: string): never => {
  throw new BadFlagError({ flag: 'viewport', command: 'shot', reason, fix: FIX });
};

/**
 * An island state declares its own `viewport` in its `*.island.states.ts`, and the harness opens one
 * browser per declared size — so a size asked for beside `--island`/`--all-islands` is a second
 * answer to a question the states already answer.
 */
export function refuseViewportWithComponent(): never {
  throw new BadFlagError({
    flag: 'viewport',
    command: 'shot',
    reason: 'sizes a route capture; an island is photographed at the viewport each state declares',
    fix: FIX,
  });
}

/** A size is its own directory name, so two sizes can never write one picture. */
export const viewportDir = (viewport: ShotViewport): string =>
  `${String(viewport.width)}x${String(viewport.height)}`;

function readSize(entry: string): ShotViewport {
  const match = SIZE.exec(entry);
  if (match === null) {
    return refuse(`${renderCauseValue(entry)} is not <width>x<height>, e.g. 390x844`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1 || width > VIEWPORT_MAX || height > VIEWPORT_MAX) {
    return refuse(`${renderCauseValue(entry)} is outside 1..${String(VIEWPORT_MAX)} on a side`);
  }
  return { width, height };
}

/**
 * The flag, every entry judged before any is returned — a run that photographed the good half and
 * refused afterwards would leave a reader with half a set and a failure. Absent is `undefined`:
 * no override, the capture's own default size. Refused, never skipped: an empty entry and the same
 * size twice are both a list the reader did not mean, and the second would overwrite the first.
 */
export function parseViewports(raw: string | undefined): readonly ShotViewport[] | undefined {
  if (raw === undefined) return undefined;
  const sizes = raw.split(',').map((entry) => readSize(entry.trim()));
  const seen = new Set<string>();
  for (const size of sizes) {
    const dir = viewportDir(size);
    if (seen.has(dir)) return refuse(`${dir} is listed twice`);
    seen.add(dir);
  }
  return sizes;
}

export interface ViewportRun {
  readonly viewports: readonly ShotViewport[];
  /** Absolute; each size lands in `<outDir>/<w>x<h>/`. */
  readonly outDir: string;
  readonly boot: () => Promise<ShotServer>;
  /** `runShot`, handed in so this module never imports the command that imports it. */
  readonly shoot: (run: ShotRun) => Promise<ShotArtifacts>;
  /** Everything a size shares: the route, the driver, the waits, the locale, the theme. */
  readonly base: Omit<ShotRun, 'outDir' | 'boot' | 'viewport'>;
}

/**
 * One server for every size, `runShotMatrix`'s rule: each capture gets a boot that never stops it,
 * and the run stops it once after the last picture. Each size is an ordinary `runShot`, so its
 * `verdict.json` means exactly what a single shot's does; `ok` only when every one is.
 */
export async function runShotViewports(run: ViewportRun): Promise<CommandResult> {
  // `parseViewports` never answers an empty list; a hand-built one is refused before the boot.
  if (run.viewports.length === 0) refuse('lists no size');
  const server = await run.boot();
  const shared: ShotServer = { ...server, stop: () => Promise.resolve() };
  const shots: { readonly viewport: ShotViewport; readonly artifacts: ShotArtifacts }[] = [];
  try {
    for (const viewport of run.viewports) {
      const artifacts = await run.shoot({
        ...run.base,
        viewport,
        outDir: join(run.outDir, viewportDir(viewport)),
        boot: () => Promise.resolve(shared),
      });
      shots.push({ viewport, artifacts });
    }
  } finally {
    await server.stop().catch(() => undefined);
  }
  // The summary is the first failure's, else the first picture's — labelled by its size, so a
  // reader of one line knows which of the sizes it speaks for.
  const worst = shots.find((shot) => !shot.artifacts.verdict.ok) ?? shots[0];
  return {
    ok: shots.every((shot) => shot.artifacts.verdict.ok),
    command: 'shot',
    summary:
      worst === undefined
        ? refuse('lists no size')
        : `${viewportDir(worst.viewport)}: ${shotSummary(worst.artifacts.verdict)}`,
    lines: shots.flatMap((shot) => [
      `${viewportDir(shot.viewport)}  ${shotSummary(shot.artifacts.verdict)}`,
      ...shotLines(shot.artifacts).map((line) => `  ${line}`),
    ]),
    data: {
      outDir: run.outDir,
      shots: shots.map((shot) => ({
        width: shot.viewport.width,
        height: shot.viewport.height,
        image: shot.artifacts.image,
        verdictFile: shot.artifacts.verdictFile,
        verdict: verdictJson(shot.artifacts.verdict),
      })),
    },
  };
}
