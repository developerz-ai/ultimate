// The palette's accessibility contract as DATA: every foreground/background pairing a shipped
// component actually renders, with the WCAG 2.2 AA floor it has to clear.
//
// In source rather than in `contrast.test.ts`, where it lived until 2026-09, because two things
// read it and only one of them is a test. `defineTheme()` measures a brand override against this
// exact list, so an app cannot ship a palette that fails the bar the framework's own palette is
// held to — that is the difference between an accessible design system and a design system with an
// accessible default.
//
// WCAG 2.2 AA, deliberately, and not APCA: APCA is not a standard, and AA is the operative legal
// benchmark (EN 301 549, ADA Title II, the EAA). 4.5:1 for body text (1.4.3), 3:1 for large text
// and non-text UI (1.4.11).

import { AA_LARGE, AA_TEXT } from './contrast';
import type { ColorRole } from './tokens';

/** What a page, a card and a raised panel are made of. */
const SURFACES: readonly ColorRole[] = ['bg', 'bg-soft', 'surface', 'surface-raised'];

const STATUS = ['success', 'warning', 'danger', 'info'] as const;

/**
 * The framework's own floor for a 1px edge, not a WCAG level: below it a border is a rumour, and
 * `line` on `surface-raised` in dark measured 1.16 — an input with no visible outline.
 */
export const VISIBLE_EDGE = 1.4;

export interface ContrastPair {
  readonly fg: ColorRole;
  readonly bg: ColorRole;
  readonly minimum: number;
  /** What the pairing IS on screen. A refusal that names only two role names explains nothing. */
  readonly what: string;
}

const pair = (fg: ColorRole, bg: ColorRole, minimum: number, what: string): ContrastPair => ({
  fg,
  bg,
  minimum,
  what,
});

const onSurfaces = (fg: ColorRole, minimum: number, what: string): ContrastPair[] =>
  SURFACES.map((bg) => pair(fg, bg, minimum, what));

/**
 * Every pairing, both directions of the palette. Order is stable so a refusal names the same pair
 * on every run and a diff of this file is a diff of the contract.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...(['fg', 'fg-strong', 'fg-muted'] as const).flatMap((fg) =>
    onSurfaces(fg, AA_TEXT, 'body, heading and caption text on a surface'),
  ),
  ...(['accent', 'accent-strong'] as const).flatMap((fg) =>
    onSurfaces(fg, AA_TEXT, 'link and accent text on a surface'),
  ),
  pair('accent-fg', 'accent', AA_TEXT, 'the label on a primary Button'),
  pair('accent-fg', 'accent-strong', AA_TEXT, 'the label on a hovered primary Button'),
  ...STATUS.map((status) =>
    pair(`${status}-fg`, status, AA_TEXT, `the label on a solid ${status} Badge`),
  ),
  ...STATUS.map((status) =>
    pair(status, `${status}-soft`, AA_TEXT, `${status} text on its own soft tint`),
  ),
  ...STATUS.map((status) =>
    pair('fg-muted', `${status}-soft`, AA_TEXT, `Alert body copy on the ${status} tint`),
  ),
  ...STATUS.flatMap((status) => onSurfaces(status, AA_TEXT, 'status text on a surface')),
  ...onSurfaces('accent', AA_LARGE, 'the focus ring against a surface'),
  ...onSurfaces('line', VISIBLE_EDGE, 'a border or divider against a surface'),
];
