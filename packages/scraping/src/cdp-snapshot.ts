// The one in-page expression this package runs, and the schema that reads its answer back.
//
// It computes exactly `ElementSnapshot` — including the two fields the offline drivers cannot
// have: the layout box, and whether the element is what a click at its own centre would hit. A
// cookie banner over the submit button is invisible to every DOM-only check ever written, and
// visible here.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
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
 * `t.string` refuses an empty string, and an element's `text` and `value` are legitimately empty
 * far more often than not — a `<div>` wrapper, an unfilled input. `.min(0)` says "a string, and
 * empty is a real answer", which is the difference between parsing a page and refusing one.
 */
const anyString = t.string.min(0);

const snapshotSchema = t.array(
  t.object({
    tag: t.string,
    attrs: t.record(anyString),
    text: anyString,
    value: anyString,
    visible: t.boolean,
    enabled: t.boolean,
    box: t.object({ x: t.number, y: t.number, width: t.number, height: t.number }),
    hitTarget: t.boolean,
  }),
) as unknown as StandardSchemaV1<unknown, ElementSnapshot[]>;

/** The browser's answer is `unknown` and stays `unknown` until this parses it. Never a cast. */
export function parseSnapshots(raw: unknown): readonly ElementSnapshot[] {
  if (typeof raw !== 'string') return parse(snapshotSchema, raw);
  return parse(snapshotSchema, JSON.parse(raw) as unknown);
}
