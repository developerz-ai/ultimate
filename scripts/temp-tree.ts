#!/usr/bin/env bun
// Enforce, as a ratchet, that a test's temp directory has ONE owner: `tempTree()` from
// `@ultimat3/testing`. Two shapes are refused. `git`: a bare `mkdtemp` beside a git spawn turned
// `main` red (`e407c015a`) — git's detached `maintenance run --auto` unlinked a lock after `git
// commit` returned, and the `rmSync` stopped silently on the vanished entry. `in-repo`: a `mkdtemp`
// under `import.meta.dir` made `packages/cli/.<name>-fixture-XXXXXX/`, which no ignore rule covers,
// and two were swept into commits; `tempTree(prefix, { inPackage })` makes it under `.x/fixtures/`.
// Pins: `scripts/lib/temp-tree-pins.ts`. "A maker also removes" is `scripts/temp-dir-cleanup.test.ts`.
//
//   bun run scripts/temp-tree.ts [--json]
//   bun run scripts/temp-tree.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { renderFixShellArg } from '../packages/core/src/error-render';
import { stripComments } from '../packages/core/src/source-mask';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { isTestPath } from './lib/source-scan';
import { TEMP_TREE_PINS, TEMP_TREE_PINS_FILE } from './lib/temp-tree-pins';

const SCRIPT = 'temp-tree';
const EXPLAIN = 'bun run scripts/temp-tree.ts --explain --json lists every one';

/** The helper's own home, which makes the one tree, and this rule's own files. */
const EXEMPT =
  /^(?:packages\/testing\/src\/temp-tree(?:-[\w-]+)?|scripts\/temp-tree)(?:\.test)?\.ts$/;

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

/** A prefix built off the module's own directory: the tree lands inside the checkout. */
const IN_REPO = /^[^;\n]*?\b(?:import\.meta\.dirname|import\.meta\.dir|__dirname)\b/;

export interface TempTreeSite {
  readonly path: string;
  /** The line of the `mkdtemp`. */
  readonly line: number;
  /** `in-repo`: made inside the checkout. `git`: made in a file that spawns git. */
  readonly form: 'in-repo' | 'git';
}

export function scanTempTrees(path: string, source: string): readonly TempTreeSite[] {
  if (!inScope(path) || !source.includes('mkdtemp')) return [];
  const code = stripComments(source);
  const git = SPAWNS_GIT.some((pattern) => pattern.test(code));
  return [...code.matchAll(MAKES)].flatMap((match) => {
    const at = match.index + match[0].length;
    const form = IN_REPO.test(code.slice(at, at + 200)) ? 'in-repo' : git ? 'git' : undefined;
    if (form === undefined) return [];
    return [{ path, line: code.slice(0, match.index).split('\n').length, form }];
  });
}

export type TempTreeGap = RatchetGap<TempTreeSite>;

export const checkTempTrees = (input: {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}): readonly TempTreeGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanTempTrees(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: TempTreeSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)} (${site.form})`;

export const tempTreeFindingFor = (gap: TempTreeGap): Finding =>
  gap.kind === 'over'
    ? {
        code: 'X_TEST_TEMP_TREE_UNOWNED',
        cause: `${gap.pkg} has ${String(gap.found)} temp director(ies) made with a bare mkdtemp inside the checkout (in-repo) or in a file that runs git (git), pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — an in-repo tree no ignore rule covers is swept into a commit, and git's background maintenance can still be writing under a tree when it is removed, which the remove then stops on silently`,
        fix: `tempTree('<prefix>-', { inPackage: join(import.meta.dir, '..') })   # from @ultimat3/testing, at ${siteTarget(gap, at)}; inPackage only when a child must resolve @ultimat3/* (it lands under the package's ignored .x/fixtures/), tempTrees() for many with one dispose(); run git as tree.git([...]) or with env { ...Bun.env, ...tree.gitEnv }, hand other children to tree.track(child), and await tree.dispose()`,
        at: leadSite(gap)?.path ?? TEMP_TREE_PINS_FILE,
      }
    : gap.kind === 'stale'
      ? {
          code: 'X_TEST_TEMP_TREE_PIN_STALE',
          cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unowned temp tree(s) and has ${String(gap.found)}, so the pin would let ${String(gap.pinned - gap.found)} back in`,
          fix: `bun run scripts/temp-tree.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
          at: TEMP_TREE_PINS_FILE,
        }
      : {
          code: 'X_CORPUS_UNSCANNED',
          cause:
            'no source file was read, so every package reports zero unowned temp trees and the ratchet enforces nothing',
          fix: 'bun run scripts/temp-tree.ts --explain --json   # reads nothing: the corpus scope source in scripts/lib/corpus.ts must match this repo',
          at: 'scripts/temp-tree.ts',
        };

const treeSites = async (root: string): Promise<readonly TempTreeSite[]> =>
  (await corpus(root, 'source')).flatMap((file) => scanTempTrees(file.path, file.source));

const PROBE: SiteProbe<TempTreeSite> = { rescan: scanTempTrees, line: (site) => site.line };

export const tempTreeGaps = async (root: string): Promise<readonly TempTreeGap[]> =>
  newSitesFirst(root, ratchetGaps(await treeSites(root), TEMP_TREE_PINS, true), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const tempTreeFindings = async (root: string): Promise<readonly Finding[]> =>
  (await tempTreeGaps(root)).map(tempTreeFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: TEMP_TREE_PINS_FILE,
    pins: TEMP_TREE_PINS,
    sites: treeSites,
    findingFor: tempTreeFindingFor,
    probe: PROBE,
    clean:
      'every test temp tree has one owner, outside the checkout or under a package .x/fixtures/',
  });
}
