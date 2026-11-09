// Heading anchors as the GitHub wiki writes them, so a `#anchor` link written against the wiki
// scrolls on a page this package renders: lowercase, punctuation but `-` and `_` dropped, spaces to
// `-`, and a repeat suffixed `-1`, `-2` in document order.

import { plainText } from './markdown-inline';
import type { MarkdownBlock } from './markdown-tree';

/** One heading's text as a slug, before de-duplication. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every heading in the tree — quotes and list items included — to its unique id. */
export function headingIds(blocks: readonly MarkdownBlock[]): Map<MarkdownBlock, string> {
  const ids = new Map<MarkdownBlock, string>();
  const seen = new Map<string, number>();
  const visit = (block: MarkdownBlock): void => {
    if (block.kind === 'heading') {
      const base = headingSlug(plainText(block.children));
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      ids.set(block, count === 0 ? base : `${base}-${count}`);
    } else if (block.kind === 'quote') block.children.forEach(visit);
    else if (block.kind === 'list') for (const item of block.items) item.children.forEach(visit);
  };
  blocks.forEach(visit);
  return ids;
}
