// The in-page expressions this package runs, and the schema that reads their answer back.
//
// It computes exactly `ElementSnapshot` — including the two fields the offline drivers cannot
// have: the layout box, and whether the element is what a click at its own centre would hit. A
// cookie banner over the submit button is invisible to every DOM-only check ever written, and
// visible here.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import { browserRecord } from './browser-record';
import type { ElementSnapshot } from './target';

/**
 * Returns JSON TEXT, not an object: a CDP round trip serialises the result anyway, and a string
 * has one deserialiser here — `parse` against the schema below — instead of an implicit one in
 * the library plus a cast.
 */
export const snapshotExpression = (selector: string): string => `(() => {
  const out = [];
  for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const attribute of el.attributes) attrs[attribute.name] = attribute.value;
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    out.push({
      tag: el.tagName.toLowerCase(),
      attrs,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
      value: typeof el.value === 'string' ? el.value : '',
      visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0',
      enabled: el.disabled !== true && el.getAttribute('aria-disabled') !== 'true',
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      hitTarget: top !== null && (top === el || el.contains(top) || el.contains(top.parentNode)),
    });
  }
  return JSON.stringify(out);
})()`;

/**
 * Emptying a control, as an expression — the one verb `CdpPageLike`/`CdpFrameLike` has no method
 * for, so it travels as text and is `evaluate`d against whichever document it is handed to.
 *
 * ONE declaration, and that is the whole point of it living here: the page target and the frame
 * target each `evaluate` it, and a second copy is how the frame half came to send the page's
 * expression to the page's own document — emptying the PARENT's same-named field while the
 * frame's kept its value and a `fill` appended to it.
 */
export const clearExpression = (selector: string): string =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`;

/**
 * `t.string` refuses an empty string, and an element's `text` and `value` are legitimately empty
 * far more often than not — a `<div>` wrapper, an unfilled input. `.min(0)` says "a string, and
 * empty is a real answer", which is the difference between parsing a page and refusing one.
 */
const anyString = t.string.min(0);

/**
 * `attrs` is absent from the shape and read by `browserRecord` instead — the one field whose KEYS
 * are the page's rather than a schema's. `t.record()` refuses `__proto__`, `constructor` and
 * `prototype` by name, so `<div constructor="Foo">` on any queried element refused the whole read;
 * see `browser-record.ts` for why the refusal is right for a request body and wrong for a DOM.
 * Every other field is still parsed, and a `tag` that is not a string still refuses.
 */
const snapshotSchema = t.array(
  t.object({
    tag: t.string,
    text: anyString,
    value: anyString,
    visible: t.boolean,
    enabled: t.boolean,
    box: t.object({ x: t.number, y: t.number, width: t.number, height: t.number }),
    hitTarget: t.boolean,
  }),
) as unknown as StandardSchemaV1<unknown, Omit<ElementSnapshot, 'attrs'>[]>;

const attrsOf = (row: unknown): unknown =>
  typeof row === 'object' && row !== null ? (row as { readonly attrs?: unknown }).attrs : undefined;

/**
 * The browser's answer is `unknown` and stays `unknown` until this reads it. Never a cast.
 *
 * The parsed rows and the raw rows are zipped by INDEX, which is sound because the array schema
 * preserves order and length: a row that failed makes the whole parse throw before this runs.
 */
export function parseSnapshots(raw: unknown): readonly ElementSnapshot[] {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const rows: readonly unknown[] = Array.isArray(value) ? (value as readonly unknown[]) : [];
  return parse(snapshotSchema, value).map((element, index) => ({
    ...element,
    attrs: browserRecord(attrsOf(rows[index])),
  }));
}
