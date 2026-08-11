// Which heading element a composite renders. A rule, not markup: PageHeader and Section both
// need it, and a page whose headings skip a level is a screen-reader outline with holes — so the
// level is a prop with one mapping, never a hardcoded <h2> inside a component.

import { invalidValueError } from '../errors';

export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];
export type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/** `2` → `'h2'`. Throws `X_UI_INVALID_VALUE` for anything off the scale. */
export function headingTag(level: HeadingLevel): HeadingTag {
  if (!(HEADING_LEVELS as readonly number[]).includes(level)) {
    throw invalidValueError('heading', level, 'a heading level from 1 to 6');
  }
  return `h${level}` as HeadingTag;
}

/**
 * The level for content nested under a heading. Clamped at 6 rather than throwing: a deeply
 * nested Section is a layout the app is allowed to build, and HTML has no `<h7>`.
 */
export function nextHeadingLevel(level: HeadingLevel): HeadingLevel {
  return (level < 6 ? level + 1 : 6) as HeadingLevel;
}
