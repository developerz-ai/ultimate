/**
 * The `localStorage` key a visitor's light/dark choice lives under. Tier 0 because the WRITER is
 * `@ultimat3/ui`'s `ThemeToggle` and the READER is `@ultimat3/render`'s inlined boot script — two
 * tier-4 packages that cannot import each other.
 */

/**
 * One declaration, imported by both. Until 25.0.0 each package carried its own literal, pinned
 * equal by a test: the two disagreeing was exactly the bug — the boot read one key, the toggle
 * wrote another, and a visitor's choice never survived a reload.
 */
export const THEME_STORAGE_KEY = 'ultimate.theme';
