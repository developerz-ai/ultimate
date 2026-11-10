// `x verify --changed`, the disk half: which app files the `drift` step's inputs reach by import,
// and which TypeScript files exist now. Read once, handed to the pure planner (`verify-changed.ts`).
// Seeds are read off the import itself — a file importing `@ultimat3/entity` declares a table
// however it is named — never off a filename convention a hand-written entity can miss.

// why: Bun ships no path API; files are read from the app root with the host's separator.
import { join } from 'node:path';
import { appSourceFiles, fileImports } from './app-module-graph';
import { isTest } from './source-files';
import type { ChangedFacts } from './verify-changed';

/** A runtime OR type import of the entity package, in any of its subpaths. */
const ENTITY_IMPORT = /['"]@ultimat3\/entity(?:\/[^'"]*)?['"]/;

interface Scanned {
  readonly path: string;
  readonly imports: readonly string[];
  readonly opaque: boolean;
  readonly seed: boolean;
}

/** Pure: the closure over already-scanned files, so the rule is testable without a tree. */
export function driftReachOf(files: readonly Scanned[]): ReadonlySet<string> | 'everything' {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const reached = new Set<string>();
  const queue = files.filter((file) => file.seed).map((file) => file.path);
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (reached.has(at)) continue;
    reached.add(at);
    const file = byPath.get(at);
    // A seed that computes an import can reach any file: nothing is provably outside drift.
    if (file?.opaque === true) return 'everything';
    for (const target of file?.imports ?? []) if (!reached.has(target)) queue.push(target);
  }
  return reached;
}

export async function readChangedFacts(root: string): Promise<ChangedFacts> {
  const paths = await appSourceFiles(root);
  const scanned: Scanned[] = [];
  for (const path of paths) {
    if (isTest(path)) continue;
    const source = await Bun.file(join(root, path)).text();
    const found = fileImports(root, path, source);
    scanned.push({
      path,
      imports: found.imports,
      opaque: found.opaque,
      seed: path.startsWith('packages/db/') || ENTITY_IMPORT.test(source),
    });
  }
  return { driftReach: driftReachOf(scanned), known: new Set(paths) };
}
