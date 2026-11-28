// `x shot <route> --against <png | .x/design/<slug>>`: the route photographed at each viewport and
// scheme the reference holds, each picture compared with the reference shot of the same pair, the
// diff written beside it and the similarity recorded in its verdict.json. Recorded, never gating:
// "how close to the reference" is a judgement for the reader, not a verdict for the gate.

// why: Bun has no synchronous directory listing or existence check, and the plan is decided
// before anything boots.
import { existsSync, readdirSync, statSync } from 'node:fs';
// why: Bun exposes no path primitives.
import { join } from 'node:path';
import { renderCauseValue, UltimateError } from '@ultimat3/core';
import {
  DESIGN_SCHEMES,
  DESIGN_VIEWPORTS,
  type DesignScheme,
  REFERENCE_SHOT_PATTERN,
  referenceShotName,
} from './cmd-design-paths';
import type { ShotRun } from './cmd-shot';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';
import { compareCaptures } from './shot-diff';
import type { ShotServer } from './shot-server';
import type { ShotTheme } from './shot-theme';
import type { ShotArtifacts } from './shot-verdict';
import { shotSummary, verdictJson } from './shot-verdict';
import type { ShotViewport } from './shot-viewport';

/** `ui.diff`'s default threshold: a tenth of a channel's range absorbs a one-level wobble. */
export const AGAINST_THRESHOLD = 0.1;

/** The size a lone PNG reference is compared at when no `--viewport` names one. */
const LONE_VIEWPORT: ShotViewport = { width: 1440, height: 900 };

export class ShotAgainstMissingError extends UltimateError {
  constructor(input: { readonly reference: string; readonly wanted: string }) {
    super({
      code: 'X_SHOT_AGAINST_MISSING',
      cause: `${renderCauseValue(input.reference)} holds no ${input.wanted} to compare against`,
      fix: 'x design research <url> --viewport 390x844,1440x900   # writes .x/design/<slug>/shot-<width>-<light|dark>.png; then: x shot <route> --against .x/design/<slug>',
      meta: { reference: input.reference, wanted: input.wanted },
    });
  }
}

/** One route shot and the reference picture it is compared with. */
export interface AgainstPair {
  readonly viewport: ShotViewport;
  readonly scheme: DesignScheme;
  /** Absolute path of the reference PNG. */
  readonly reference: string;
}

export interface AgainstPlanInput {
  /** Absolute: a PNG, or a `x design research` slug directory. */
  readonly reference: string;
  readonly viewports?: readonly ShotViewport[] | undefined;
  readonly theme?: ShotTheme | undefined;
}

/** The height a width is laid out at: the design viewport of that width, else the desktop's. */
const heightFor = (width: number): number =>
  DESIGN_VIEWPORTS.find((viewport) => viewport.width === width)?.height ?? LONE_VIEWPORT.height;

/**
 * Decided before anything boots. A directory pairs every shot it holds, narrowed by `--viewport`
 * and `--theme`; a pair asked for and not held is refused, never skipped — a comparison that
 * quietly covered half of what was asked reads as a whole one.
 */
export function planAgainst(input: AgainstPlanInput): readonly AgainstPair[] {
  const { reference } = input;
  if (!existsSync(reference)) {
    throw new ShotAgainstMissingError({ reference, wanted: 'file or directory' });
  }
  if (!statSync(reference).isDirectory()) {
    const viewport = input.viewports?.[0] ?? LONE_VIEWPORT;
    return [{ viewport, scheme: input.theme ?? 'light', reference }];
  }
  const held = readdirSync(reference)
    .map((name) => REFERENCE_SHOT_PATTERN.exec(name))
    .filter((match) => match !== null)
    .map((match) => ({ width: Number(match[1]), scheme: match[2] as DesignScheme }))
    .sort((a, b) => a.width - b.width || a.scheme.localeCompare(b.scheme));
  const schemes = input.theme === undefined ? DESIGN_SCHEMES : [input.theme];
  if (input.viewports === undefined) {
    const pairs = held.filter((shot) => schemes.includes(shot.scheme));
    if (pairs.length === 0) {
      throw new ShotAgainstMissingError({
        reference,
        wanted: `shot-<width>-${input.theme ?? '<light|dark>'}.png`,
      });
    }
    return pairs.map((shot) => ({
      viewport: { width: shot.width, height: heightFor(shot.width) },
      scheme: shot.scheme,
      reference: join(reference, referenceShotName(shot.width, shot.scheme)),
    }));
  }
  return input.viewports.flatMap((viewport) =>
    schemes.map((scheme) => {
      const name = referenceShotName(viewport.width, scheme);
      if (!held.some((shot) => shot.width === viewport.width && shot.scheme === scheme)) {
        throw new ShotAgainstMissingError({ reference, wanted: name });
      }
      return { viewport, scheme, reference: join(reference, name) };
    }),
  );
}

/** `--against` photographs ONE route at the reference's pairs; another subject beside it is two. */
export function refuseAgainstWith(flag: 'matrix' | 'island' | 'all-islands'): never {
  throw new BadFlagError({
    flag: 'against',
    command: 'shot',
    reason: `compares one route with a reference; --${flag} is another subject`,
    fix: 'x shot / --against .x/design/<slug> --json',
  });
}

export interface AgainstShot {
  readonly width: number;
  readonly height: number;
  readonly scheme: DesignScheme;
  readonly image: string;
  readonly verdictFile: string;
  readonly reference: string;
  readonly diff: string;
  readonly similarity: number;
  readonly changedPercent: number;
  readonly artifacts: ShotArtifacts;
}

export interface AgainstRun {
  readonly pairs: readonly AgainstPair[];
  /** Absolute; each pair lands in `<outDir>/<width>-<scheme>/`. */
  readonly outDir: string;
  readonly boot: () => Promise<ShotServer>;
  /** `runShot`, handed in so this module never imports the command that imports it. */
  readonly shoot: (run: ShotRun) => Promise<ShotArtifacts>;
  readonly base: Omit<ShotRun, 'outDir' | 'boot' | 'viewport' | 'colorScheme'>;
}

/** One server for every pair, `runShotViewports`' rule; each capture is an ordinary `runShot`. */
export async function runAgainst(
  run: AgainstRun,
): Promise<{ readonly ok: boolean; readonly shots: readonly AgainstShot[] }> {
  const server = await run.boot();
  const shared: ShotServer = { ...server, stop: () => Promise.resolve() };
  const shots: AgainstShot[] = [];
  try {
    for (const pair of run.pairs) {
      const key = `${String(pair.viewport.width)}-${pair.scheme}`;
      const outDir = join(run.outDir, key);
      const artifacts = await run.shoot({
        ...run.base,
        viewport: pair.viewport,
        colorScheme: pair.scheme,
        outDir,
        boot: () => Promise.resolve(shared),
      });
      const compared = await compareCaptures(
        await Bun.file(pair.reference).bytes(),
        await Bun.file(artifacts.image).bytes(),
        AGAINST_THRESHOLD,
      );
      const diff = join(outDir, `diff-${key}.png`);
      await Bun.write(diff, compared.diffPng);
      const against = {
        reference: pair.reference,
        diff,
        similarity: compared.similarity,
        changedPercent: compared.changedPercent,
        changedBox: compared.changedBox,
        threshold: AGAINST_THRESHOLD,
      };
      // Merged into the verdict `runShot` wrote, never replacing its `ok`: recorded, not gating.
      const written: unknown = await Bun.file(artifacts.verdictFile).json();
      const verdict = typeof written === 'object' && written !== null ? written : {};
      await Bun.write(
        artifacts.verdictFile,
        `${JSON.stringify({ ...verdict, against }, null, 2)}\n`,
      );
      shots.push({
        width: pair.viewport.width,
        height: pair.viewport.height,
        scheme: pair.scheme,
        image: artifacts.image,
        verdictFile: artifacts.verdictFile,
        reference: pair.reference,
        diff,
        similarity: compared.similarity,
        changedPercent: compared.changedPercent,
        artifacts,
      });
    }
  } finally {
    await server.stop().catch(() => undefined);
  }
  return { ok: shots.every((shot) => shot.artifacts.verdict.ok), shots };
}

export function againstResult(run: {
  readonly ok: boolean;
  readonly shots: readonly AgainstShot[];
}): CommandResult {
  const lowest = [...run.shots].sort((a, b) => a.similarity - b.similarity)[0];
  return {
    ok: run.ok,
    command: 'shot',
    summary:
      lowest === undefined
        ? msg('cli.shot.against.none')
        : msg('cli.shot.against.summary', {
            pairs: run.shots.length,
            similarity: lowest.similarity,
            pair: `${String(lowest.width)}-${lowest.scheme}`,
          }),
    lines: run.shots.map((shot) =>
      msg('cli.shot.against.line', {
        pair: `${String(shot.width)}-${shot.scheme}`,
        similarity: shot.similarity,
        diff: shot.diff,
        summary: shotSummary(shot.artifacts.verdict),
      }),
    ),
    data: {
      shots: run.shots.map((shot) => ({
        width: shot.width,
        height: shot.height,
        scheme: shot.scheme,
        image: shot.image,
        verdictFile: shot.verdictFile,
        reference: shot.reference,
        diff: shot.diff,
        similarity: shot.similarity,
        changedPercent: shot.changedPercent,
        verdict: verdictJson(shot.artifacts.verdict),
      })),
    },
  };
}
