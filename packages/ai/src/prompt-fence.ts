// The data fences of a prompt template: which XML-style tag pairs enclose each `{{slot}}`, and the
// neutraliser `render` applies to the prompt those values were assembled into. A fence is the template's declaration
// that a slot is DATA; a value that writes the fence's own closer would end it early and speak as
// the prompt (#689), so that closer is broken — never deleted, the model still reads every word.

/** `<name>` or `<name attr="…">` — a fence opener. Self-closing and closing tags are not openers. */
const OPEN = /<([A-Za-z_][\w.-]*)(?:\s[^<>]*)?(?<!\/)>/g;
/** `</name>`, as the template author writes it. */
const CLOSE = /<\/([A-Za-z_][\w.-]*)\s*>/g;
/**
 * A `{{slot}}`. The ONE pattern: `render` substitutes by it and `fenceMap` keys offsets by it, so
 * the two can never disagree about where a slot is.
 */
export const SLOT = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

interface TagMark {
  readonly name: string;
  readonly at: number;
}

const marks = (template: string, pattern: RegExp): readonly TagMark[] =>
  [...template.matchAll(pattern)].map((match) => ({ name: match[1] ?? '', at: match.index }));

/**
 * The fences enclosing the offset `at`, outermost first. A tag encloses it when its LAST opener
 * before `at` is not closed before `at`, and a closer follows — read per name, never as a stack, so
 * a stray `<note>` in prose fences nothing and cannot unbalance the real fences around it.
 */
function enclosing(
  opens: readonly TagMark[],
  closes: readonly TagMark[],
  at: number,
): readonly string[] {
  const found: TagMark[] = [];
  for (const name of new Set(opens.map((mark) => mark.name))) {
    const opener = opens.findLast((mark) => mark.name === name && mark.at < at);
    if (opener === undefined) continue;
    const named = closes.filter((mark) => mark.name === name);
    const closedBefore = named.some((mark) => mark.at > opener.at && mark.at < at);
    if (!closedBefore && named.some((mark) => mark.at > at)) found.push(opener);
  }
  return found.sort((a, b) => a.at - b.at).map((mark) => mark.name);
}

/**
 * Each FENCED slot occurrence's offset, mapped to the closers its value must not keep: every fence
 * the template draws, not only the ones around it. A title is no safer for writing `</post_body>`
 * than `</post_title>` — a model reads tags in order, and a forged closer of a later fence is one
 * more place the data seems to end.
 */
export function fenceMap(template: string): ReadonlyMap<number, readonly string[]> {
  const opens = marks(template, OPEN);
  const closes = marks(template, CLOSE);
  const drawn = [...new Set(opens.map((mark) => mark.name))].filter((name) =>
    closes.some(
      (close) => close.name === name && opens.some((o) => o.name === name && o.at < close.at),
    ),
  );
  const map = new Map<number, readonly string[]>();
  for (const slot of template.matchAll(SLOT)) {
    if (enclosing(opens, closes, slot.index).length > 0) map.set(slot.index, drawn);
  }
  return map;
}

/**
 * Per slot name, the fences enclosing EVERY occurrence of it — so one bare occurrence reports the
 * slot as unfenced, which is what an app's own test asserts against ("is `body` data?").
 */
export function promptFences(template: string): Readonly<Record<string, readonly string[]>> {
  const opens = marks(template, OPEN);
  const closes = marks(template, CLOSE);
  const out: Record<string, readonly string[]> = {};
  for (const slot of template.matchAll(SLOT)) {
    const name = slot[1] ?? '';
    const here = enclosing(opens, closes, slot.index);
    // Own keys only: a slot named `constructor` must not read Object.prototype's.
    const before = Object.hasOwn(out, name) ? out[name] : undefined;
    out[name] = before === undefined ? here : before.filter((tag) => here.includes(tag));
  }
  return out;
}

const escapeName = (name: string): string => name.replace(/[.-]/g, '\\$&');

/** Where a fenced slot's value landed in the rendered prompt: `[start, end)`. */
export interface FencedSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Break every closer of `fences` in the ASSEMBLED prompt that a fenced value wrote any character
 * of. Per value was not enough: `{{a}}{{b}}` with `</post_` and `body>` rebuilt a whole closer from
 * two halves, and a value ending `</post_` beside template text `body>` completed one. So the scan
 * runs over the rendered text, and a closer the template wrote alone — no value inside it — stands.
 *
 * A closer is `<`, `/` and the name, any case, whitespace either side of the slash, and ANYTHING
 * after the name that does not continue it: `</post_body foo=1>`, `</post_body/>` and a bare
 * `</post_body` read as one to a lenient model. `<\/name` is the shape `assembleContext` uses for
 * `</document>`: the marker is broken, the text survives.
 */
export function neutraliseFenced(
  rendered: string,
  spans: readonly FencedSpan[],
  fences: readonly string[],
): string {
  if (fences.length === 0 || spans.length === 0) return rendered;
  const closer = new RegExp(`<\\s*\\/\\s*(?:${fences.map(escapeName).join('|')})(?![\\w.-])`, 'gi');
  let out = '';
  let from = 0;
  for (const match of rendered.matchAll(closer)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!spans.some((span) => span.start < end && span.end > start)) continue;
    const slash = rendered.indexOf('/', start);
    out += `${rendered.slice(from, slash)}\\`;
    from = slash;
  }
  return out + rendered.slice(from);
}

/**
 * A value that is data from its first character to its last — a retrieved document, not a slot in
 * a template. The same pass as `neutraliseFenced`, one span wide: one neutraliser in this package.
 */
export const neutraliseFences = (value: string, fences: readonly string[]): string =>
  neutraliseFenced(value, [{ start: 0, end: value.length }], fences);
