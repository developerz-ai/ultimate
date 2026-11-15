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

/** The codemods a hop from `from` to `to` owes, in the order they run. */
export function pendingCodemods(
  codemods: readonly Codemod[],
  from: string,
  to: string,
): readonly Codemod[] {
  return codemods
    .filter(
      (codemod) =>
        compareVersions(codemod.since, from) > 0 && compareVersions(codemod.since, to) <= 0,
    )
    .sort((a, b) => compareVersions(a.since, b.since) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A path's staged state: its new text, or null for removed. */
type Staged = Map<string, string | null>;

/** `base` as `layers` leave it: the newest layer that names a path answers for it. */
function stagedView(base: CodemodApp, layers: readonly Staged[], top: Staged): CodemodApp {
  const lookup = (path: string): string | null | undefined => {
    for (const layer of [top, ...[...layers].reverse()]) {
      if (layer.has(path)) return layer.get(path);
    }
    return undefined;
  };
  const read = async (path: string): Promise<string | undefined> => {
    const staged = lookup(path);
    if (staged === null) return undefined;
    return staged ?? (await base.read(path));
  };
  return {
    root: base.root,
    read,
    exists: async (path) => (await read(path)) !== undefined,
    write: async (path, source) => {
      top.set(path, source);
    },
    remove: async (path) => {
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
  const applied: CodemodOutcome[] = [];
  for (const codemod of pendingCodemods(input.codemods, from, to)) {
    const top: Staged = new Map();
    const before = stagedView(app, layers, new Map());
    const head = { id: codemod.id, since: codemod.since, summary: codemod.summary };
    try {
      const result = await codemod.run(stagedView(app, layers, top));
      const changed = await changedBy(top, before);
      layers.push(top);
      applied.push({ ...head, changed, skipped: result.skipped });
    } catch (error) {
      // A framework bug, never the app's: its half-done writes go, and the next codemod still runs.
      const reason = `the codemod threw, so it changed nothing: ${renderThrowable(error)}`;
      applied.push({ ...head, changed: [], skipped: [{ path: '.', reason }] });
    }
  }
  if (!dryRun) {
    const final = new Map<string, string | null>();
    for (const layer of layers) for (const [path, text] of layer) final.set(path, text);
    for (const [path, text] of final) {
      const held = await app.read(path);
      if (text === null && held !== undefined) await app.remove(path);
      else if (text !== null && text !== held) await app.write(path, text);
    }
  }
  return { from, to, dryRun, applied };
}
