/**
 * HTML text and attribute serialization for the server renderer. The character table is
 * `@ultimat3/core`'s `escapeHtml`, imported from core by every render-* file: a second escaper is
 * how one of them ends up missing a character, and a missing character in an attribute is an
 * injection (`X_HELPER_COPY` refuses both a copy and a re-export).
 */

import { escapeHtml, safeUrl, URL_ATTRIBUTES } from '@ultimat3/core';
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

/**
 * `<script>` and `<style>` hold RAW TEXT: a character reference is not decoded inside them, so
 * `escapeHtml` there would ship `&lt;` to a JS or CSS parser and corrupt the code without closing
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
 * entity-DECODED and then parsed as HTML, so an escaped `&lt;script&gt;` becomes a live
 * `<script>` inside the iframe — on this origin, with this session's cookie. Escaping cannot make
 * it inert, so the attribute is refused instead, the same way `innerHTML` above stays the one
 * explicit escape hatch rather than a prop anyone can spread in from a row.
 */
const REFUSED_ATTRIBUTES: ReadonlySet<string> = new Set(['srcdoc']);

/**
 * The only shape that can be written between `<div` and `>` without ending the attribute. A name
 * is not escaped anywhere — it is emitted verbatim before the `=` — so a key carrying a space
 * carries a whole second attribute with it: `{ 'x onmouseover=alert(1) y': 'ok' }` emitted a live
 * event handler out of an object KEY, which is `<div {...row} />` over a JSON body or a JSONB
 * column. Narrower than the HTML spec's name production on purpose: everything an app actually
 * writes (`data-*`, `aria-*`, `xlink:href`, a `__proto__`-named column) matches, and the refusal
 * is `null` — the same "emit nothing" this function already answers for a refused URL.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;

const isAttributeName = (name: string): boolean => ATTRIBUTE_NAME.test(name);

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
 * What a prop NAME means, decided once: the name every check below reads off is a pure function of
 * the string, and a big page asks the same five names a million times. `null` = never emitted.
 */
interface NameVerdict {
  readonly attribute: string;
  readonly kind: 'plain' | 'style' | 'url';
  /** The lowercased spelling `safeUrl` is keyed on. */
  readonly folded: string;
}

function judgeName(name: string): NameVerdict | null {
  if (NON_ATTRIBUTES.has(name)) return null;
  if (!isAttributeName(name)) return null;
  // Folded, because HTML attribute names are case-insensitive and the two checks below already
  // fold: `ONERROR="alert(1)"` went out on the wire off a spread row for as long as this line was
  // `name.startsWith('on')`.
  if (name.length > 2 && name.toLowerCase().startsWith('on')) return null;
  const attribute = ATTRIBUTE_ALIASES.get(name) ?? name;
  const folded = attribute.toLowerCase();
  if (REFUSED_ATTRIBUTES.has(folded)) return null;
  if (attribute === 'style') return { attribute, kind: 'style', folded };
  return { attribute, kind: URL_BEARING_ATTRIBUTES.has(folded) ? 'url' : 'plain', folded };
}

/**
 * Bounded: a name can come off a spread row (`<div {...row} />`), so the set of names is the
 * data's, not the code's. Past the cap a name is judged every time — correct, only slower.
 */
const NAME_CACHE_MAX = 1024;
const nameCache = new Map<string, NameVerdict | null>();

function verdictOf(name: string): NameVerdict | null {
  const cached = nameCache.get(name);
  if (cached !== undefined || nameCache.has(name)) return cached ?? null;
  const verdict = judgeName(name);
  if (nameCache.size < NAME_CACHE_MAX) nameCache.set(name, verdict);
  return verdict;
}

/**
 * One prop → one attribute string, or `null` when it emits nothing. Event handlers are dropped
 * rather than stringified: the server has no listeners, and `onclick="function(){…}"` would ship
 * a broken inline handler that looks like it works.
 */
export function attributePair(name: string, value: unknown): string | null {
  if (value === undefined || value === null || value === false) return null;
  if (typeof value === 'function') return null;
  const verdict = verdictOf(name);
  if (verdict === null) return null;
  const { attribute } = verdict;
  if (value === true) return attribute;
  if (verdict.kind === 'style') {
    const style = styleValue(value);
    return style === null ? null : `style="${escapeHtml(style)}"`;
  }
  const text = typeof value === 'string' ? value : String(value);
  // Escaping makes a value inert inside the quotes; it cannot make a SCHEME inert, because
  // `href="javascript:alert(1)"` never leaves them. One choke point for both, here, because this
  // module is the single place injection is prevented and an href off a database row is the shape
  // every app writes. A refused URL emits no attribute at all — an anchor with no `href` is inert
  // and still renders its text, where a blanked one is a live link nobody checked.
  if (verdict.kind === 'url') {
    const url = safeUrl(text, verdict.folded);
    if (url === null) return null;
    return `${attribute}="${escapeHtml(url)}"`;
  }
  return `${attribute}="${escapeHtml(text)}"`;
}

/**
 * Own enumerable keys, as `Object.entries` gave, without building a pair array per element: on a
 * 50k-row page that allocation was the walker's single largest cost (plan 101 slice 14 P1).
 */
export function renderAttributes(props: JsxProps): string {
  let out = '';
  for (const name in props) {
    if (!Object.hasOwn(props, name)) continue;
    const pair = attributePair(name, props[name]);
    if (pair !== null) out += ` ${pair}`;
  }
  return out;
}
