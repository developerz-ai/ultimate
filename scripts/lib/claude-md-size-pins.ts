// The per-file byte ceilings for package `CLAUDE.md` files above the 24 KB default, read by
// `scripts/claude-md-size.ts`. Each is the file's size on 2026-09-23, when the rule landed: a
// ratchet that refuses GROWTH only. Shrink a file, then lower its number here (or delete the row
// once the file is under 24 KB); never raise one.

/** Where the pins live, so a finding can name the file to edit. */
export const CLAUDE_MD_PINS_FILE = 'scripts/lib/claude-md-size-pins.ts';

/** Bytes, per repo-relative path. */
export const CLAUDE_MD_PINS: Readonly<Record<string, number>> = {};
