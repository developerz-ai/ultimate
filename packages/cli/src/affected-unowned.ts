// The checkout's top-level directories that no workspace owns or contains — in this repository,
// `scripts/`: tests that import packages by relative path and declare no dependency on any, so the
// workspace graph cannot say which change reaches them. `affected.ts` runs them for every change
// that selects a workspace at all.

// why: Bun ships no directory listing with file types.
import { readdir } from 'node:fs/promises';
import type { WorkspaceNode } from './workspace-graph';

/** Never a home for a test the run should select: dependencies, git, build state. */
const SKIPPED = (name: string): boolean => name.startsWith('.') || name === 'node_modules';

/** A root-level workspace (`''` or `.`) owns the whole checkout. */
const isRoot = (dir: string): boolean => dir === '' || dir === '.';

/**
 * Pure: `entries` (top-level directory names) less any that is, or holds, a workspace — sorted.
 * A directory that holds one (`packages/`, `examples/`) is answered for by the graph.
 */
export function unownedDirs(
  graph: readonly WorkspaceNode[],
  entries: readonly string[],
): readonly string[] {
  if (graph.some((node) => isRoot(node.dir))) return [];
  return entries
    .filter((entry) => !SKIPPED(entry))
    .filter(
      (entry) => !graph.some((node) => node.dir === entry || node.dir.startsWith(`${entry}/`)),
    )
    .sort();
}

/** The same, read off the checkout root's own directory listing. */
export async function readUnownedDirs(
  root: string,
  graph: readonly WorkspaceNode[],
): Promise<readonly string[]> {
  const listed = await readdir(root, { withFileTypes: true });
  return unownedDirs(
    graph,
    listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
}
