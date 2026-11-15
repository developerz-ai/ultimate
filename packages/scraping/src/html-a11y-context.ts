// What a match's ANCESTORS and DESCENDANTS say about its accessible name, which a flat snapshot
// cannot carry: the `<label>` a control sits inside, and the `alt` of every `<img>` inside it.
//
// One `HTMLRewriter` pass, answering in `queryHtml`'s own order — a void match at its open tag,
// every other at its end tag, the unclosed last — so entry `i` describes snapshot `i`.

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

export interface NameContext {
  /** The text of the innermost `<label>` the match sits inside, or `undefined` when none. */
  readonly label: string | undefined;
  /** The `alt` of every `<img>` inside the match, in document order. */
  readonly alts: readonly string[];
}

interface LabelRecord {
  readonly parts: string[];
}

interface MatchRecord {
  readonly label: LabelRecord | undefined;
  readonly alts: string[];
}

const settle = (record: MatchRecord): NameContext => ({
  label:
    record.label === undefined
      ? undefined
      : record.label.parts.join('').replaceAll(/\s+/g, ' ').trim(),
  alts: record.alts,
});

export async function nameContexts(html: string, selector: string): Promise<NameContext[]> {
  const done: MatchRecord[] = [];
  const open: MatchRecord[] = [];
  const labels: LabelRecord[] = [];
  const rewriter = new HTMLRewriter()
    .on('label', {
      element(element): void {
        const record: LabelRecord = { parts: [] };
        labels.push(record);
        element.onEndTag(() => {
          const index = labels.lastIndexOf(record);
          if (index !== -1) labels.splice(index, 1);
        });
      },
    })
    .on('*', {
      text(chunk): void {
        for (const label of labels) label.parts.push(chunk.text);
      },
    })
    .on('img', {
      element(element): void {
        const alt = element.getAttribute('alt');
        if (alt !== null) for (const record of open) record.alts.push(alt);
      },
    })
    .on(selector, {
      element(element): void {
        const record: MatchRecord = { label: labels.at(-1), alts: [] };
        if (VOID_TAGS.has(element.tagName.toLowerCase())) {
          done.push(record);
          return;
        }
        open.push(record);
        element.onEndTag(() => {
          const index = open.lastIndexOf(record);
          if (index !== -1) open.splice(index, 1);
          done.push(record);
        });
      },
    });
  await rewriter.transform(new Response(html)).text();
  for (const record of open) done.push(record);
  return done.map(settle);
}
