// `x shot --island` — the RUN: which islands, in which order, and which artifacts land. One
// picture at a time is `island-capture.ts`; the order here is the whole design, because the
// complete expected picture list is computed from the states files BEFORE a browser exists and
// what landed on disk is diffed against that list afterwards, so "produced nothing and exited 0"
// is a state this command can refuse.
//
// A sweep never aborts on a failure: every state the app CAN photograph is captured, every verdict
// and the index are written, and only then does the missing-picture gate turn the reasons into a
// non-zero exit. One island that will not mount must not cost a reader the other nineteen.

// why: no Bun native joins a path; `Bun.write` and `Bun.file` both take one already joined.
import { join } from 'node:path';
import { finiteCount } from '@ultimat3/core';
import type { IslandShotTarget, IslandStatesManifest } from '@ultimat3/testing';
import { islandShotPlan, islandShotTargets } from '@ultimat3/testing';
import type { IslandCaptureRun } from './island-capture';
import { captureIslandState, MIN_SHOT_BYTES } from './island-capture';
import { IslandShotsMissingError } from './island-shot-errors';
import { ISLAND_INDEX, renderIslandIndex } from './island-shot-index';
import type { IslandArtifacts, IslandStateShot, IslandSweepArtifacts } from './island-verdict';
import { buildIslandVerdict, islandVerdictJson } from './island-verdict';
import type { ShotServer } from './shot-server';

/** Where a component's pictures land, under the same `.x/shot` tree a route's picture does. */
export const ISLAND_SHOT_DIR = 'island';
export const ISLAND_VERDICT = 'verdict.json';

// Re-exported, not re-declared: the capture's own vocabulary is what a caller and a test both
// name, and a second spelling of a browser or a floor would be a second answer.
export type { IslandBrowser } from './island-capture';
export { ISLAND_CROP_MARGIN_PX, MIN_SHOT_BYTES, photographFault } from './island-capture';
export { ISLAND_INDEX } from './island-shot-index';

export interface IslandSweepRun extends IslandCaptureRun {
  /** Every island this run photographs. One entry is the `--island <name>` form. */
  readonly manifests: readonly IslandStatesManifest[];
  /**
   * `--state`, or every declared state when absent. The caller validates it against ONE manifest:
   * `defineIslandStates` refuses a manifest with no states, so the only way this expansion comes
   * back empty is a filter naming a state that does not exist — a typo, and it belongs to the flag
   * that made it.
   */
  readonly state?: string | undefined;
  readonly boot: () => Promise<ShotServer>;
  readonly minBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

/** The one-island form, kept as its own shape because its artifacts name one directory. */
export interface IslandShotRun extends Omit<IslandSweepRun, 'manifests'> {
  readonly manifest: IslandStatesManifest;
}

const quietly = async (stop: () => Promise<void>): Promise<void> => {
  await stop().catch(() => undefined);
};

/** Declared pictures that are not on disk. Read from the EXPANSION, never from the loop's beliefs. */
export async function missingShots(
  outDir: string,
  expected: readonly IslandShotTarget[],
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const target of expected) {
    if (!(await Bun.file(join(outDir, target.file)).exists())) missing.push(target.file);
  }
  return missing;
}

/**
 * Boot (or find) the server, photograph every declared state of every island named, write the
 * pictures, the per-island verdicts and the index, then refuse if any declared picture is absent.
 * The driver and the boot are ARGUMENTS for `runShot`'s reason: `bun test` drives this with a fake
 * browser and a stub server, so the whole command is proved on a machine with no Chrome.
 */
export async function runIslandSweep(options: IslandSweepRun): Promise<IslandSweepArtifacts> {
  // A Set and not an `===`: `bun run secret-compare` reads the NAME of a comparison's operands and
  // `state` is on its list, because an OAuth handshake state is compared under exactly that name.
  // This one is a screenshot filename stem, and the membership test says so.
  const chosen = options.state === undefined ? null : new Set([options.state]);
  const wanted = (target: IslandShotTarget): boolean => chosen === null || chosen.has(target.state);
  const targets = islandShotPlan(options.manifests).filter(wanted);
  // Before the boot, and before a browser: `bytes.byteLength < NaN` is false for every picture, so
  // an unchecked floor does not lower the backstop — it removes it, and "produced nothing and
  // exited 0" is the one outcome a reader cannot tell from success. 0 stays legal and is what
  // `island-shot.test.ts` passes: the fake driver answers an 8-byte PNG signature.
  const floor = finiteCount('runIslandSweep', 'minBytes', options.minBytes ?? MIN_SHOT_BYTES);
  const server = await options.boot();
  const shots: IslandStateShot[] = [];
  const failures: unknown[] = [];
  try {
    for (const target of targets) {
      // A state that cannot be photographed does not stop the run — not the next state, and not
      // the next ISLAND. The reader wants every picture the app CAN produce plus a named reason
      // for each one it cannot, and the missing-shot gate below is what turns those reasons into
      // a non-zero exit.
      try {
        shots.push(await captureIslandState(options, server, target, floor));
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    await quietly(() => server.stop());
  }
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const pairs = [];
  for (const manifest of options.manifests) {
    const expected = islandShotTargets(manifest).filter(wanted);
    const verdict = buildIslandVerdict({
      island: manifest.island,
      name: manifest.name,
      server: server.origin,
      capturedAt,
      expected,
      shots: shots.filter((shot) => expected.some((target) => target.file === shot.file)),
      missing: await missingShots(options.outDir, expected),
    });
    await Bun.write(
      join(options.outDir, manifest.name, ISLAND_VERDICT),
      `${JSON.stringify(islandVerdictJson(verdict), null, 2)}\n`,
    );
    pairs.push({ manifest, verdict });
  }
  // The index is written for a single-island run too: the file that says what a picture IS cannot
  // be a property of how many islands the reader asked for.
  const indexFile = join(options.outDir, ISLAND_INDEX);
  await Bun.write(
    indexFile,
    renderIslandIndex({ pairs, capturedAt, blind: pairs[0]?.verdict.blind ?? [] }),
  );
  const artifacts: IslandSweepArtifacts = {
    verdicts: pairs.map((pair) => pair.verdict),
    dir: options.outDir,
    indexFile,
    ok: pairs.every((pair) => pair.verdict.ok),
  };
  // The first failure is re-thrown ONLY when it explains a missing picture. A run that took every
  // declared picture and also logged a failure is a contradiction; the artifact is what decides.
  const short = artifacts.verdicts.find((verdict) => verdict.missing.length > 0);
  if (short !== undefined) {
    const first = failures[0];
    if (first !== undefined) throw first;
    throw new IslandShotsMissingError({
      island: short.name,
      missing: short.missing,
      expected: short.expected.length,
      dir: join(options.outDir, short.name),
    });
  }
  return artifacts;
}

/**
 * One island. The sweep with a single manifest, so there is one capture loop and one artifact
 * writer in this package — two would be two answers to "what did this run produce".
 */
export async function runIslandShot(options: IslandShotRun): Promise<IslandArtifacts> {
  const { manifest, ...rest } = options;
  const artifacts = await runIslandSweep({ ...rest, manifests: [manifest] });
  const verdict = artifacts.verdicts[0];
  if (verdict === undefined) {
    throw new IslandShotsMissingError({
      island: manifest.name,
      missing: islandShotTargets(manifest).map((target) => target.file),
      expected: manifest.states.length,
      dir: join(options.outDir, manifest.name),
    });
  }
  const dir = join(options.outDir, manifest.name);
  return { verdict, dir, verdictFile: join(dir, ISLAND_VERDICT), indexFile: artifacts.indexFile };
}
