// Single responsibility: the CHANGELOG / Upgrading facts both `changelog-check.ts` (the count rule)
// and `changelog-pairing.ts` (the pairing rule) read — stated once, in a leaf, so the two rules
// can never read different lines and neither imports the other.

export const CHANGELOG_PATH = 'CHANGELOG.md';
export const UPGRADING_PATH = 'wiki/Upgrading.md';

/**
 * One line, one breaking entry — the identical regex wiki/Upgrading.md hands the reader in a fenced
 * `grep -cE`. Anchored at column 0 deliberately: an INDENTED `- **BREAKING —` is a sub-bullet of
 * the entry above it and not an entry of its own, which is how the `Bun.Image` entry carries three.
 */
export const BREAKING_ENTRY = /^(?:- \*\*|### )BREAKING —/;
