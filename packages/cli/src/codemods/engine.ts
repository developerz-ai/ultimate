// The codemod engine: the codemods a hop owes (`since` in (from, to], version then id), each run
// over a staged view of the app so the next one sees its output, a throw costs only its own
// writes, and `--dry-run` is the same run minus the final flush. Pure over `CodemodApp`.

import { renderThrowable } from '@ultimat3/core';
import { compareVersions } from '../upgrade-plan';
import type { Codemod, CodemodApp, CodemodSkip } from './codemod';

export interface CodemodOutcome {
  readonly id: string;
  readonly since: string;
  readonly summary: string;
  /** The files this codemod left different from how it found them, written or removed. */
  readonly changed: readonly string[];
  readonly skipped: readonly CodemodSkip[];
}

export interface CodemodsReport {
  readonly from: string;
  readonly to: string;
  readonly dryRun: boolean;
  /** Every codemod that ran, in the order it ran, whether or not it changed anything. */
  readonly applied: readonly CodemodOutcome[];
}

/**
 * Release order on the `major.minor.patch` triple: a prerelease (`32.0.0-next.1`) is its release,
 * which carries every codemod `since` it — `compareVersions` alone reads it as 0.0.0.
 */
const compareRelease = (a: string, b: string): number =>
  compareVersions(a.split('-')[0] ?? a, b.split('-')[0] ?? b);

/** The codemods a hop from `from` to `to` owes, in the order they run. */
export function pendingCodemods(
  codemods: readonly Codemod[],
  from: string,
  to: string,
): readonly Codemod[] {
  return codemods
    .filter(
      (codemod) =>
        compareRelease(codemod.since, from) > 0 && compareRelease(codemod.since, to) <= 0,
    )
    .sort((a, b) => compareRelease(a.since, b.since) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A path's staged state: its new text, or null for removed. */
type Staged = Map<string, string | null>;

/** The bytes the run first saw at each path it touched (undefined: no file): what a flush checks. */
type Seen = Map<string, string | undefined>;

/** `base` as `layers` leave it: the newest layer that names a path answers for it. */
function stagedView(
  base: CodemodApp,
  layers: readonly Staged[],
  top: Staged,
  seen: Seen,
): CodemodApp {
  const baseRead = async (path: string): Promise<string | undefined> => {
    if (seen.has(path)) return seen.get(path);
    const text = await base.read(path);
    seen.set(path, text);
    return text;
  };
  const lookup = (path: string): string | null | undefined => {
    for (const layer of [top, ...[...layers].reverse()]) {
      if (layer.has(path)) return layer.get(path);
    }
    return undefined;
  };
  const read = async (path: string): Promise<string | undefined> => {
    const staged = lookup(path);
    if (staged === null) return undefined;
    return staged ?? (await baseRead(path));
  };
  return {
    root: base.root,
    read,
    exists: async (path) => (await read(path)) !== undefined,
    write: async (path, source) => {
      await baseRead(path);
      top.set(path, source);
    },
    remove: async (path) => {
      await baseRead(path);
      top.set(path, null);
    },
    glob: async (pattern) => {
      const glob = new Bun.Glob(pattern);
      const paths = new Set(await base.glob(pattern));
      for (const layer of [...layers, top]) {
        for (const [path, text] of layer) {
          if (!glob.match(path)) continue;
          if (text === null) paths.delete(path);
          else paths.add(path);
        }
      }
      const held: string[] = [];
      for (const path of paths) if ((await read(path)) !== undefined) held.push(path);
      return held.sort();
    },
  };
}

/** The paths a layer really changed: a write of the bytes already there is none. */
async function changedBy(layer: Staged, before: CodemodApp): Promise<readonly string[]> {
  const changed: string[] = [];
  for (const [path, text] of layer) {
    if ((text ?? undefined) !== (await before.read(path))) changed.push(path);
  }
  return changed.sort();
}

export async function runCodemods(input: {
  readonly app: CodemodApp;
  readonly codemods: readonly Codemod[];
  readonly from: string;
  readonly to: string;
  readonly dryRun: boolean;
}): Promise<CodemodsReport> {
  const { app, from, to, dryRun } = input;
  const layers: Staged[] = [];
  const seen: Seen = new Map();
  const applied: CodemodOutcome[] = [];
  for (const codemod of pendingCodemods(input.codemods, from, to)) {
    const top: Staged = new Map();
    const before = stagedView(app, layers, new Map(), seen);
    const head = { id: codemod.id, since: codemod.since, summary: codemod.summary };
    try {
      const result = await codemod.run(stagedView(app, layers, top, seen));
      const changed = await changedBy(top, before);
      layers.push(top);
      applied.push({ ...head, changed, skipped: result.skipped });
    } catch (error) {
      // A framework bug, never the app's: its half-done writes go, and the next codemod still runs.
      const reason = `the codemod threw, so it changed nothing: ${renderThrowable(error)}`;
      applied.push({ ...head, changed: [], skipped: [{ path: '.', reason }] });
    }
  }
  if (dryRun) return { from, to, dryRun, applied };
  const final = new Map<string, string | null>();
  for (const layer of layers) for (const [path, text] of layer) final.set(path, text);
  const moved = await movedSince(app, final, seen);
  if (moved.length > 0) return { from, to, dryRun, applied: refused(applied, moved) };
  await flush(app, final);
  return { from, to, dryRun, applied };
}

/** The staged paths whose bytes on disk are no longer the ones the run read. */
async function movedSince(
  app: CodemodApp,
  final: ReadonlyMap<string, string | null>,
  seen: Seen,
): Promise<readonly string[]> {
  const moved: string[] = [];
  for (const path of final.keys()) {
    if (seen.has(path) && (await app.read(path)) !== seen.get(path)) moved.push(path);
  }
  return moved;
}

/** Nothing lands: each moved file is said, on the codemod that would have written it. */
function refused(
  applied: readonly CodemodOutcome[],
  moved: readonly string[],
): readonly CodemodOutcome[] {
  const reason =
    'changed on disk while the codemods ran, so no file was written: rerun x upgrade codemods on the tree as it is now';
  return applied.map((one) => ({
    ...one,
    changed: [],
    skipped: [
      ...one.skipped,
      ...one.changed.filter((path) => moved.includes(path)).map((path) => ({ path, reason })),
    ],
  }));
}

/**
 * Writes first, removals after: interrupted between them, the tree holds both the old evidence and
 * the new file — never neither, which a rerun would read as a different app.
 */
async function flush(app: CodemodApp, final: ReadonlyMap<string, string | null>): Promise<void> {
  for (const [path, text] of final) {
    if (text !== null && text !== (await app.read(path))) await app.write(path, text);
  }
  for (const [path, text] of final) {
    if (text === null && (await app.read(path)) !== undefined) await app.remove(path);
  }
}
