// The Lucide glyph shape as data, and the one gate between glyph data and markup:
// only these tags, only these attributes, only token-safe paint. Pure, so the rule
// is testable with no renderer — the package's `*-view.ts` convention.

import { invalidGlyphError } from '../errors';

/**
 * A Lucide `IconNode`: `[tag, attributes]` pairs, the shape `lucide-static` publishes and the
 * shape `src/icons/glyphs/*.ts` is generated into. Structural, so an upstream icon node passes
 * straight in with no adapter.
 */
export type IconGlyph = readonly (readonly [
  tag: string,
  attrs: Readonly<Record<string, string>>,
])[];

/**
 * Tag → the attributes it may carry. The allowlist is the security property: a glyph is data, and
 * data reaching an attribute sink unchecked is how `onload=` or `href=` gets into the DOM.
 */
export const ICON_TAGS = {
  circle: ['cx', 'cy', 'r', 'fill'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'x2', 'y1', 'y2'],
  path: ['d'],
  polygon: ['points'],
  polyline: ['points'],
  rect: ['height', 'rx', 'ry', 'width', 'x', 'y'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type IconTag = keyof typeof ICON_TAGS;

export interface IconElement {
  readonly tag: IconTag;
  readonly attrs: Readonly<Record<string, string>>;
}

/** The only paint values allowed: a literal colour in a glyph would bypass the token system. */
const FILL_VALUES: ReadonlySet<string> = new Set(['none', 'currentColor']);

export function isIconTag(tag: string): tag is IconTag {
  return Object.hasOwn(ICON_TAGS, tag);
}

const known = (tag: IconTag): readonly string[] => ICON_TAGS[tag];

/**
 * Validate a glyph and hand back its elements. Throws rather than silently dropping: a glyph that
 * lost an attribute renders as a plausible-looking wrong icon, which is the bug nobody notices.
 */
export function iconElements(glyph: IconGlyph): readonly IconElement[] {
  const elements: IconElement[] = [];
  for (const [tag, attrs] of glyph) {
    if (!isIconTag(tag)) {
      throw invalidGlyphError(`tag <${tag}>`, `one of ${Object.keys(ICON_TAGS).join(', ')}`);
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (!known(tag).includes(name)) {
        throw invalidGlyphError(
          `attribute "${name}" on <${tag}>`,
          `one of ${known(tag).join(', ')}`,
        );
      }
      if (name === 'fill' && !FILL_VALUES.has(value)) {
        throw invalidGlyphError(
          `fill="${value}"`,
          'fill="none" or fill="currentColor" — colour comes from the theme, never from the glyph',
        );
      }
    }
    elements.push({ tag, attrs });
  }
  return elements;
}
