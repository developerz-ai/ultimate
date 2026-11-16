// The source-header ratchet: one row per shipped file whose leading header is not yet in the
// 1–4-line responsibility contract. Data only; the count may fall and may never rise.
//
// A pin is per FILE, not per package: a package-level count lets one repaired file pay for one
// new violation elsewhere, so the guard would enforce nothing at the site that changed.
//
// A row's reason is the sentence it stands on: the file opens with no header comment, or its
// leading first paragraph runs past four lines.
//
// why: this table opens with the whole debt at once — every shipped file whose leading header is
// outside the 1–4-line contract today — because the rule lands on a tree that already carries it;
// each row may fall as its file is repaired and may never rise.
//
//   bun run scripts/source-headers.ts --json

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const SOURCE_HEADER_PINS_FILE = 'scripts/lib/source-header-pins.ts';

export interface SourceHeaderPin {
  readonly count: number;
  readonly reason: string;
}

/**
 * Empty since plan 101b sweep 8b-2 (2026-11-16): every shipped source file opens with its header.
 * A row here again is a regression someone chose not to fix yet, with its reason.
 */
export const SOURCE_HEADER_PINS: Readonly<Record<string, SourceHeaderPin>> = {};
