/**
 * HTML text and attribute serialization for the server renderer. Escaping lives here and only
 * here: a second escaper is how one of them ends up missing a character, and a missing character
 * in an attribute is an injection.
 */

import { safeUrl, URL_ATTRIBUTES } from '@ultimat3/core';
import type { JsxProps } from './jsx';

/** Elements that never carry children, so the writer must not emit a closing tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

/**
 * `<script>` and `<style>` hold RAW TEXT: a character reference is not decoded inside them, so
 * `escapeText` there would ship `&lt;` to a JS or CSS parser and corrupt the code without closing
 * the hole. What actually ends the element is `</` followed by its tag name, and — inside a script
 * only — `<!--` switches the tokenizer into the escaped state where the element's own `</script>`
 * no longer closes it and the rest of the document becomes script text.
 *
 * So the two sequences are made unwritable instead. `\/` and `\!` are the identity escape in a JS
 * string, a JS regex, a CSS string and a CSS url(), which is where a `</` in authored code lives;
 * outside a string neither `</` nor `<!--` is valid code in either language.
 */
export function escapeRawTextContent(value: string): string {
  return value.replaceAll('</', '<\\/').replaceAll('<!--', '<\\!--');
}

/**
 * The same element, when its content is JSON rather than code — `application/ld+json`, which is
 * built from route data and is therefore the path attacker text takes. JSON gets the total rule:
 * `<` is the same character to `JSON.parse`, so nothing survives that could spell `</script`
 * or `<!--`, and the body stays byte-for-byte valid JSON.
 *
 * Safe by construction because `<`, `>`, `&`, U+2028 and U+2029 can only occur INSIDE a JSON
 * string — no JSON structural token contains one — so every replacement lands where `\u` means
 * an escape. U+2028/U+2029 are legal in a JSON string and illegal in a JS one, and this content
 * is read back by both.
 */
export function escapeJsonContent(json: string): string {
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/**
 * JSX prop name → attribute name. Solid authors write the HTML spelling (`class`, `for`), but the
 * React spellings compile too, and an author who writes one and gets no attribute has a bug with
 * no error message.
 *
 * A `Map` like the two sets above, never a record: an object lookup walks the prototype chain, so
 * `<div {...row} />` with a column named `toString` resolved the alias to a FUNCTION and the URL
 * check below called `.toLowerCase()` on it — a bare TypeError, no code, no fix, and the page 500s.
 */
const ATTRIBUTE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['className', 'class'],
  ['htmlFor', 'for'],
]);

/** Props the tree consumes rather than emits. `innerHTML` is emitted as content, not an attribute. */
const NON_ATTRIBUTES: ReadonlySet<string> = new Set([
  'children',
  'ref',
  'key',
  'innerHTML',
  'textContent',
]);

/**
 * Attributes a browser FOLLOWS, beyond the four `@ultimat3/core` names for the anchor case. Kept
 * here rather than in `safe-url.ts` only because that file is another package's; the scheme check
 * is one rule and every attribute a scheme can execute from belongs under it. `data` is
 * `<object data>`, `poster` is `<video poster>`, `xlink:href` executes on click inside inline SVG,
 * and `ping` is a URL the browser POSTs to on activation.
 */
const URL_BEARING_ATTRIBUTES: ReadonlySet<string> = new Set([
  ...URL_ATTRIBUTES,
  'data',
  'ping',
  'poster',
  'xlink:href',
]);

/**
 * Attributes that carry MARKUP, not text or a URL, and are therefore never emitted. `srcdoc` is
 * entity-DECODED and then parsed as HTML, so `escapeAttribute`'s `&lt;script&gt;` becomes a live
 * `<script>` inside the iframe — on this origin, with this session's cookie. Escaping cannot make
 * it inert, so the attribute is refused instead, the same way `innerHTML` above stays the one
 * explicit escape hatch rather than a prop anyone can spread in from a row.
 */
const REFUSED_ATTRIBUTES: ReadonlySet<string> = new Set(['srcdoc']);

const cssProperty = (name: string): string =>
  name.startsWith('--') ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** `{ marginTop: '1rem' }` → `margin-top:1rem`. A string style passes through untouched. */
export function styleValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && item !== null && item !== false)
    .map(([name, item]) => `${cssProperty(name)}:${String(item)}`);
  return parts.length === 0 ? null : parts.join(';');
}

/**
 * One prop → one attribute string, or `null` when it emits nothing. Event handlers are dropped
 * rather than stringified: the server has no listeners, and `onclick="function(){…}"` would ship
 * a broken inline handler that looks like it works.
 */
export function attributePair(name: string, value: unknown): string | null {
  if (NON_ATTRIBUTES.has(name)) return null;
  if (value === undefined || value === null || value === false) return null;
  if (typeof value === 'function') return null;
  if (name.startsWith('on') && name.length > 2) return null;

  const attribute = ATTRIBUTE_ALIASES.get(name) ?? name;
  if (REFUSED_ATTRIBUTES.has(attribute.toLowerCase())) return null;
  if (value === true) return attribute;
  if (attribute === 'style') {
    const style = styleValue(value);
    return style === null ? null : `style="${escapeAttribute(style)}"`;
  }
  const text = String(value);
  // Escaping makes a value inert inside the quotes; it cannot make a SCHEME inert, because
  // `href="javascript:alert(1)"` never leaves them. One choke point for both, here, because this
  // module is the single place injection is prevented and an href off a database row is the shape
  // every app writes. A refused URL emits no attribute at all — an anchor with no `href` is inert
  // and still renders its text, where a blanked one is a live link nobody checked.
  if (URL_BEARING_ATTRIBUTES.has(attribute.toLowerCase())) {
    const url = safeUrl(text, attribute.toLowerCase());
    if (url === null) return null;
    return `${attribute}="${escapeAttribute(url)}"`;
  }
  return `${attribute}="${escapeAttribute(text)}"`;
}

export function renderAttributes(props: JsxProps): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(props)) {
    const pair = attributePair(name, value);
    if (pair !== null) parts.push(pair);
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}
