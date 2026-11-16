#!/usr/bin/env bun
// Enforce, as a ratchet, that a temp directory git runs in has ONE owner who waits for its
// children: `tempTree()` from `@ultimat3/testing`. A bare `mkdtemp` beside a git spawn is the shape
// that turned `main` red (`e407c015a`): git's detached `maintenance run --auto` still unlinking a
// lock after `git commit` returned, and the test's `rmSync` stopping silently on the vanished entry.
// Pins: `scripts/lib/temp-tree-git-pins.ts`. The "a maker also removes" half is
// `scripts/temp-dir-cleanup.test.ts`'s.
//
//   bun run scripts/temp-tree-git.ts [--json]
//   bun run scripts/temp-tree-git.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { renderFixShellArg } from '../packages/core/src/error-render';
import { stripComments } from '../packages/core/src/source-mask';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { isTestPath } from './lib/source-scan';
import { TEMP_TREE_GIT_PINS, TEMP_TREE_GIT_PINS_FILE } from './lib/temp-tree-git-pins';

const SCRIPT = 'temp-tree-git';
const EXPLAIN = 'bun run scripts/temp-tree-git.ts --explain --json lists every one';

/** The helper's own home, which makes the one tree, and this rule's own files. */
const EXEMPT =
  /^(?:packages\/testing\/src\/temp-tree(?:-[\w-]+)?|scripts\/temp-tree-git)(?:\.test)?\.ts$/;

/** What a test runs: test files, fixtures, the harness package, the repo's scripts. */
export const inScope = (path: string): boolean =>
  !EXEMPT.test(path) &&
  (isTestPath(path) ||
    /-fixture\.tsx?$/.test(path) ||
    path.startsWith('packages/testing/src/') ||
    path.startsWith('scripts/') ||
    /^packages\/[^/]+\/e2e\//.test(path));

const MAKES = /\bmkdtemp(?:Sync)?\(/g;

/**
 * git, spawned: an argv whose head is `'git'`, a git helper called with a cwd and a subcommand
 * (`git(dir, 'commit', …)`), or a shell line that starts with it. A recorded fake's expected argv
 * reads the same — converting that file costs nothing and the rule stays one shape.
 */
const SPAWNS_GIT: readonly RegExp[] = [
  /\[\s*['"]git['"]\s*,/,
  /\bgit\(\s*[\w.$]+\s*,\s*['"`]/,
  /(?:\$|\bsh|\bexec)\s*\(?\s*`\s*git\b/,
];

export interface TempTreeGitSite {
  readonly path: string;
  /** The line of the `mkdtemp` a git runs under. */
  readonly line: number;
}

export function scanTempTreeGit(path: string, source: string): readonly TempTreeGitSite[] {
  if (!inScope(path) || !source.includes('mkdtemp') || !source.includes('git')) return [];
  const code = stripComments(source);
  if (!SPAWNS_GIT.some((pattern) => pattern.test(code))) return [];
  return [...code.matchAll(MAKES)].map((match) => ({
    path,
    line: code.slice(0, match.index).split('\n').length,
  }));
}

export type TempTreeGitGap = RatchetGap<TempTreeGitSite>;

export const checkTempTreeGit = (input: {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}): readonly TempTreeGitGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanTempTreeGit(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: TempTreeGitSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

export const tempTreeGitFindingFor = (gap: TempTreeGitGap): Finding =>
  gap.kind === 'over'
    ? {
        code: 'X_TEST_TEMP_TREE_UNOWNED',
        cause: `${gap.pkg} has ${String(gap.found)} temp director(ies) made with a bare mkdtemp in a file that runs git, pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — git's background maintenance can still be writing under one when it is removed, and the remove then stops silently`,
        fix: `tempTree('<prefix>-')   # from @ultimat3/testing, at ${siteTarget(gap, at)}, held as await using tree = …: run git as tree.git([...]) or with env { ...Bun.env, ...tree.gitEnv }, hand other children to tree.track(child), and let dispose() remove it`,
        at: leadSite(gap)?.path ?? TEMP_TREE_GIT_PINS_FILE,
      }
    : gap.kind === 'stale'
      ? {
          code: 'X_TEST_TEMP_TREE_PIN_STALE',
          cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unowned temp tree(s) beside git and has ${String(gap.found)}, so the pin would let ${String(gap.pinned - gap.found)} back in`,
          fix: `bun run scripts/temp-tree-git.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
          at: TEMP_TREE_GIT_PINS_FILE,
        }
      : {
          code: 'X_CORPUS_UNSCANNED',
          cause:
            'no source file was read, so every package reports zero unowned temp trees and the ratchet enforces nothing',
          fix: 'bun run scripts/temp-tree-git.ts --explain --json   # reads nothing: the corpus scope source in scripts/lib/corpus.ts must match this repo',
          at: 'scripts/temp-tree-git.ts',
        };

const treeSites = async (root: string): Promise<readonly TempTreeGitSite[]> =>
  (await corpus(root, 'source')).flatMap((file) => scanTempTreeGit(file.path, file.source));

const PROBE: SiteProbe<TempTreeGitSite> = { rescan: scanTempTreeGit, line: (site) => site.line };

export const tempTreeGitGaps = async (root: string): Promise<readonly TempTreeGitGap[]> =>
  newSitesFirst(root, ratchetGaps(await treeSites(root), TEMP_TREE_GIT_PINS, true), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const tempTreeGitFindings = async (root: string): Promise<readonly Finding[]> =>
  (await tempTreeGitGaps(root)).map(tempTreeGitFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: TEMP_TREE_GIT_PINS_FILE,
    pins: TEMP_TREE_GIT_PINS,
    sites: treeSites,
    findingFor: tempTreeGitFindingFor,
    probe: PROBE,
    clean: 'every temp tree git runs in has one owner who waits for its children',
  });
}
