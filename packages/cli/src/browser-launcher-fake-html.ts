// CSS selectors over an HTML string, on Bun's own `HTMLRewriter`: the `query()` the offline
// `fakeShotDriver` answers from markup. The selector subset is lol-html's — type, `#id`, `.class`,
// `[attr]`, `[attr=value]`, descendant and child combinators. No box and no hit-target on any
// answer: this has no layout engine, and a fabricated box would make a covered button clickable.
import type { ElementSnapshot } from './browser-launcher-port';

/** Elements with no end tag: `onEndTag` never fires for them, so they close on open. */
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

const visible = (tag: string, attrs: ReadonlyMap<string, string>): boolean =>
  !attrs.has('hidden') &&
  !(tag === 'input' && attrs.get('type')?.toLowerCase() === 'hidden') &&
  !HIDDEN_STYLE.test(attrs.get('style') ?? '') &&
  attrs.get('aria-hidden') !== 'true';

interface Open {
  readonly tag: string;
  readonly attrs: Map<string, string>;
  readonly parts: string[];
}

const finish = (open: Open): ElementSnapshot => ({
  tag: open.tag,
  attrs: Object.fromEntries(open.attrs),
  text: open.parts.join('').replaceAll(/\s+/g, ' ').trim(),
  value: open.attrs.get('value') ?? '',
  visible: visible(open.tag, open.attrs),
  enabled: !open.attrs.has('disabled') && open.attrs.get('aria-disabled') !== 'true',
});

/** Every element matching `selector`, as the markup states it. A selector lol-html refuses throws. */
export async function queryHtml(
  html: string,
  selector: string,
): Promise<readonly ElementSnapshot[]> {
  const done: ElementSnapshot[] = [];
  const open: Open[] = [];
  const rewriter = new HTMLRewriter().on(selector, {
    element(element): void {
      const tag = element.tagName.toLowerCase();
      const attrs = new Map<string, string>();
      for (const [name, value] of element.attributes) attrs.set(name.toLowerCase(), value);
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
      // Every OPEN match: `div, span` matches both, and both contain the text.
      for (const record of open) record.parts.push(chunk.text);
    },
  });
  await rewriter.transform(new Response(html)).text();
  // Never closed is malformed markup; the element still matched, so it is still reported.
  for (const record of open) done.push(finish(record));
  return done;
}
