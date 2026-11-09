// The search index: one entry per page, per `##`/`###` section and per code, in the shape
// `searchDocs` ranks (`@ultimat3/manifest/docs-search`). Built once at build time and served as a
// static file, so the island ranks with the same function `x docs` does and fetches no server.

import type { DocEntry } from '@ultimat3/manifest/docs-search';
import { clipText, leadOf, plainText } from './lead';
import type { DocPiece, DocsCorpus } from './types';

/** Snippets stay short: the index is one file a browser downloads before its first answer. */
const MAX_TEXT = 240;

const clip = (text: string): string => clipText(text, MAX_TEXT);

const entry = (topic: string, title: string, text: string, symbols: readonly string[] = []) =>
  ({
    topic,
    package: 'wiki',
    version: '',
    kind: 'guide',
    title,
    text: clip(text),
    symbols,
    source: topic,
  }) satisfies DocEntry;

/** The page's own entry, then one per `##` and `###` heading under it, each at its anchor. */
function pieceEntries(piece: DocPiece): readonly DocEntry[] {
  const lines = piece.markdown.split('\n');
  const sections = piece.headings
    .filter((heading) => heading.level === 2 || heading.level === 3)
    .map((heading) => {
      const at = lines.findIndex((line) => /^#{2,3}\s/.test(line) && line.includes(heading.text));
      const text = at === -1 ? '' : leadOf(lines.slice(at + 1).join('\n'));
      return entry(`${piece.url}#${heading.anchor}`, plainText(heading.text), text);
    });
  return [entry(piece.url, piece.title, piece.lead), ...sections];
}

export function searchEntries(corpus: DocsCorpus): readonly DocEntry[] {
  const codes = corpus.codes.map((piece) => {
    const first = piece.rows[0];
    const [means, cause] = first?.cells ?? [];
    return entry(
      piece.url,
      `${piece.code}: ${plainText(means?.markdown ?? '')}`,
      plainText(cause?.markdown ?? ''),
      [piece.code],
    );
  });
  return [...[...corpus.pages, ...corpus.majors].flatMap(pieceEntries), ...codes];
}
