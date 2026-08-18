// CSS selectors over an HTML string, on Bun's own `HTMLRewriter` — no jsdom, no cheerio, no
// dependency at all. This is what makes the fake and the fixture drivers real enough to be worth
// testing against: they answer the same `query()` the browser driver does, from markup, offline.
//
// The selector subset is `HTMLRewriter`'s (lol-html): type, `#id`, `.class`, `[attr]`,
// `[attr=value]`, descendant and child combinators. A selector it refuses is refused loudly.

import type { ElementSnapshot } from './target';
import { ROOT_SELECTOR } from './target';

/** Elements with no end tag — `onEndTag` is not available for them, so they close on open. */
const VOID_TAGS = new Set([
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
  'source',
  'track',
  'wbr',
]);

const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/i;

/** What "rendered" can mean without a layout engine: the markup says so, or it does not. */
export const markupVisible = (tag: string, attrs: Readonly<Record<string, string>>): boolean => {
  if ('hidden' in attrs) return false;
  if (tag === 'input' && attrs['type']?.toLowerCase() === 'hidden') return false;
  const style = attrs['style'];
  if (style !== undefined && HIDDEN_STYLE.test(style)) return false;
  return attrs['aria-hidden'] !== 'true';
};

export const markupEnabled = (attrs: Readonly<Record<string, string>>): boolean =>
  !('disabled' in attrs) && attrs['aria-disabled'] !== 'true';

interface Open {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly parts: string[];
}

const finish = (open: Open): ElementSnapshot => ({
  tag: open.tag,
  attrs: open.attrs,
  text: open.parts.join('').replaceAll(/\s+/g, ' ').trim(),
  value: open.attrs['value'] ?? '',
  visible: markupVisible(open.tag, open.attrs),
  enabled: markupEnabled(open.attrs),
  // No box and no hit-target: THIS TARGET HAS NO LAYOUT ENGINE. Fabricating either is how an
  // offline suite reports a covered button as clickable. See `actionability.ts`.
});

/**
 * Every element matching `selector`, in document order, with its text content flattened.
 *
 * `ROOT_SELECTOR` answers even for a fragment with no `<html>` element — a fixture is usually a
 * body snippet, and `page.text()` returning `''` for one would be a silent wrong answer rather
 * than a missing element.
 */
export async function queryHtml(
  html: string,
  selector: string,
): Promise<readonly ElementSnapshot[]> {
  const done: ElementSnapshot[] = [];
  const open: Open[] = [];
  const allText: string[] = [];
  const rewriter = new HTMLRewriter()
    .on('*', {
      text(chunk): void {
        allText.push(chunk.text);
      },
    })
    .on(selector, {
      element(element): void {
        const tag = element.tagName.toLowerCase();
        const attrs: Record<string, string> = {};
        for (const [name, value] of element.attributes) attrs[name.toLowerCase()] = value;
        const record: Open = { tag, attrs, parts: [] };
        if (VOID_TAGS.has(tag)) {
          done.push(finish(record));
          return;
        }
        open.push(record);
        element.onEndTag(() => {
          const index = open.lastIndexOf(record);
          if (index !== -1) open.splice(index, 1);
          done.push(finish(record));
        });
      },
      text(chunk): void {
        // Every OPEN match, not just the innermost: a `<div>` and the `<span>` inside it both
        // legitimately match `div, span`, and both contain the text.
        for (const record of open) record.parts.push(chunk.text);
      },
    });
  await rewriter.transform(new Response(html)).text();
  // Anything still open never saw its end tag (malformed markup). It is still an element that
  // matched, so it is reported rather than dropped — a scraper's input is somebody else's HTML.
  for (const record of open) done.push(finish(record));
  if (done.length === 0 && selector === ROOT_SELECTOR) {
    return [
      {
        tag: 'html',
        attrs: {},
        text: allText.join('').replaceAll(/\s+/g, ' ').trim(),
        value: '',
        visible: true,
        enabled: true,
      },
    ];
  }
  return done;
}
