// The grammar a `defineTheme()` shadow override must match. Validated, never escaped: the value is
// written into a `<style>` element, so the only safe answer to a `;`, a `}` or a `</style>` is a
// refusal. Strict enough to hold that line, wide enough for every rung `_shadow.scss` ships.

import { COLOR_ROLES } from '../tokens/color-tokens';

/** `0`, or a signed length in a unit a shadow is written in. No `calc()`, no `var()`. */
const LENGTH = String.raw`(?:0|-?\d+(?:\.\d+)?(?:px|rem|em))`;
const ALPHA = String.raw`(?:0|1|0?\.\d+)`;
const CHANNEL = String.raw`\d{1,3}`;
/** A role reference, so a shadow can follow the theme — the shape `t.role()` compiles to. */
const ROLE_COLOUR = String.raw`rgb\(var\(--color-([a-z0-9-]+)\) / ${ALPHA}\)`;
const CHANNEL_COLOUR = String.raw`rgb\((${CHANNEL}) (${CHANNEL}) (${CHANNEL})(?: / ${ALPHA})?\)`;
const LAYER = `(?:inset )?${LENGTH} ${LENGTH}(?: ${LENGTH}){0,2} (?:${ROLE_COLOUR}|${CHANNEL_COLOUR})`;

const LAYER_PATTERN = new RegExp(`^${LAYER}$`);

/** Long enough for five layers; a value past it is not a shadow anyone designed. */
const MAX_LENGTH = 400;

export const SHADOW_EXPECTED =
  'a box-shadow such as "0 4px 14px rgb(17 15 13 / 0.1)" or "0 0 14px rgb(var(--color-accent) / 0.4)" — layers comma-separated, colours as rgb() over channels or a colour role, or "none"';

/**
 * Whether `value` is a shadow this seam will write. Every layer is matched whole, every channel is
 * 0–255, and every role a layer names is a role the palette has — a `--color-brand` that resolves
 * to nothing would render no shadow at all and no error anywhere.
 */
export function isShadowValue(value: string): boolean {
  if (value === 'none') return true;
  if (value.length === 0 || value.length > MAX_LENGTH) return false;
  return value.split(', ').every((layer) => {
    const match = LAYER_PATTERN.exec(layer);
    if (match === null) return false;
    const [, role, r, g, b] = match;
    if (role !== undefined) return (COLOR_ROLES as readonly string[]).includes(role);
    return [r, g, b].every((channel) => Number(channel) <= 255);
  });
}
