// A masked source with every template literal's `${…}` bodies put back. `maskLiterals` blanks a
// template whole — its interpolations with it — so a rule reading masked code saw
// `` sig === `sha256=${hmac(body)}` `` as a comparison against a constant. The static text of a
// template is still in the source; what is interpolated is code, and runs.

import { maskLiterals } from '../../packages/core/src/source-mask';

/** Index just past the `}` closing an interpolation whose body starts at `from`, in raw text. */
function interpolationEnd(text: string, from: number): number {
  let depth = 1;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === '\\') at += 1;
    else if (char === "'" || char === '"' || char === '`') {
      for (at += 1; at < text.length && text[at] !== char; at += 1) {
        if (text[at] === '\\') at += 1;
      }
    } else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return text.length;
}

/**
 * `code` (the `maskLiterals` of `source`, offsets shared) with each template's interpolation
 * bodies restored from `source` — themselves masked, so a string inside one stays blank. The
 * template's static text and its backticks are left exactly as the mask wrote them.
 */
export function withInterpolations(source: string, code: string): string {
  const out = code.split('');
  for (let at = 0; at < code.length; at += 1) {
    if (code[at] !== '`') continue;
    const close = code.indexOf('`', at + 1);
    if (close === -1) break;
    for (let index = at + 1; index < close; index += 1) {
      if (source[index] === '\\') index += 1;
      else if (source[index] === '$' && source[index + 1] === '{') {
        const end = Math.min(interpolationEnd(source, index + 2), close);
        const body = maskLiterals(source.slice(index + 2, end - 1)).replace(/[`'"]/g, ' ');
        for (let offset = 0; offset < body.length; offset += 1) {
          out[index + 2 + offset] = body[offset] as string;
        }
        index = end - 1;
      }
    }
    at = close;
  }
  return out.join('');
}

/** Whether a template operand, as `withInterpolations` writes it, interpolates anything. */
export const interpolates = (operand: string): boolean => /^`[^`]*\S[^`]*`/.test(operand);
