// The ratchet under `scripts/temp-tree.ts`: how many temp directories each package's tests,
// fixtures and scripts make with a bare `mkdtemp` inside the checkout or in a file that runs git,
// instead of `tempTree()`.
// The number may FALL and may never rise. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/temp-tree.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const TEMP_TREE_PINS_FILE = 'scripts/lib/temp-tree-pins.ts';

/**
 * Empty since 2026-11-15 (sweep 7): every test temp tree beside git, and every one inside the
 * checkout, is a `tempTree()` (or, in a tier-4 test, a tree under its package's `.x/fixtures/`).
 * A package absent is zero.
 */
export const TEMP_TREE_PINS: Readonly<Record<string, number>> = {};
