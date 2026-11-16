// The ratchet under `scripts/temp-tree-git.ts`: how many temp directories each package's tests,
// fixtures and scripts make with a bare `mkdtemp` in a file that runs git, instead of `tempTree()`.
// The number may FALL and may never rise. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/temp-tree-git.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const TEMP_TREE_GIT_PINS_FILE = 'scripts/lib/temp-tree-git-pins.ts';

/**
 * Measured 2026-11-15, on the rule's first run, after every `packages/cli/src/*.test.ts` and
 * fixture it named moved onto `tempTree()`. What is left was outside the sweep that wrote it.
 */
export const TEMP_TREE_GIT_PINS: Readonly<Record<string, number>> = {
  // why: the rule is new — `packages/cli/e2e/upgrade.e2e.test.ts` (commits in its app) and
  // `packages/cli/src/templates/scaffold-claude-hook.test.ts` (`git init`) were outside its sweep.
  cli: 2,
  // why: the rule is new — `scripts/upgrade-fixtures-run.ts` (3), `scripts/private-names.test.ts`
  // (3), `scripts/preflight.test.ts`, `scripts/public-api.test.ts`,
  // `scripts/lib/changelog-unreleased.test.ts` and `scripts/lib/ratchet-sites.test.ts` were outside
  // the sweep that wrote it.
  scripts: 10,
};
