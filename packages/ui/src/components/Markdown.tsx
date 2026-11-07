// What a model or a person wrote, rendered: text → tree → elements, never HTML. Raw HTML, a
// `javascript:` link and a remote image all print inert. Re-parsed per change and keyed by block
// index, so a streaming body keeps every finished block's node and only the open one redraws.

import { finiteCount } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { headingIds } from '../content/heading-slug';
import type { Language } from '../content/highlight';
import { parseMarkdown } from '../content/markdown-parse';
import type { MarkdownBlock } from '../content/markdown-tree';
import { cx } from '../cx';
import { solid } from '../theme/solid-adapter';
import { keyedRows } from './data-table-rows';
import { type HeadingLevel, headingTag } from './heading-level';
import styles from './Markdown.module.scss';
import { blockNode, type ResolvedImage } from './markdown-nodes';

export type { ResolvedImage };

export interface MarkdownProps {
  /** The body. Malformed markdown is never an error: what cannot parse prints as text. */
  text: string;
  /** The level a `#` renders at. Defaults to 2: a body never adds a second `h1` to a page. */
  baseLevel?: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
  /** Vouch for an image: its served source and box, or `null` to print its alt as a link. */
  resolveImage?: ((src: string) => ResolvedImage | null) | undefined;
  /**
   * Give each heading the id the GitHub wiki would (`headingSlug`), de-duplicated `-1`, `-2` in
   * order, so a `#anchor` link scrolls. Off by default: two bodies on one page would collide.
   */
  headingIds?: boolean | undefined;
  /** Languages fences may highlight with. Absent: fences are plain text, and an island pays 0 B. */
  languages?: readonly Language[] | undefined;
  class?: string | undefined;
}

export function Markdown(props: MarkdownProps): JSX.Element {
  const rt = solid();
  // A level off the 1–6 scale (NaN included) is `X_UI_INVALID_VALUE` from `headingTag`.
  const base = (): number => {
    const level = finiteCount('Markdown', 'baseLevel', props.baseLevel ?? 2, 1);
    headingTag(level as HeadingLevel);
    return level;
  };
  // A block equal to the last parse's block at its index is that same object, so its node and
  // everything under it stay put while a later block grows.
  let previous: readonly MarkdownBlock[] = [];
  let previousJson: readonly string[] = [];
  const blocks = rt.createMemo((): readonly MarkdownBlock[] => {
    const parsed = parseMarkdown(props.text);
    const json = parsed.map((block) => JSON.stringify(block));
    const stable = parsed.map((block, index) =>
      json[index] === previousJson[index] ? (previous[index] ?? block) : block,
    );
    previous = stable;
    previousJson = json;
    return stable;
  });
  const ids = rt.createMemo(() => headingIds(blocks()));
  // Keyed by position: the block at an index is the same object until its content changes.
  let position = new Map<MarkdownBlock, number>();
  const nodes = keyedRows<MarkdownBlock, JSX.Element>(
    rt,
    (block) => String(position.get(block) ?? -1),
    (block) => (
      <>
        {blockNode(block(), {
          baseLevel: base(),
          resolveImage: props.resolveImage,
          languages: props.languages,
          ids: props.headingIds === true ? ids() : undefined,
        })}
      </>
    ),
  );

  const rendered = rt.createMemo(() => {
    const current = blocks();
    position = new Map(current.map((block, index) => [block, index]));
    return nodes(current);
  });

  return <div class={cx(styles['markdown'], props.class)}>{rendered()}</div>;
}
