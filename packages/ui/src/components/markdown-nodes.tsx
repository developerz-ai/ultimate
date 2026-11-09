// Markdown tree → elements. Every string is a JSX text node and every element is written out here,
// so a body cannot name a tag or an attribute. Fences go through `CodeBlock`: one path for code.

import type { JSX } from 'solid-js';
import type { Language } from '../content/highlight';
import type { MarkdownBlock, MarkdownInline } from '../content/markdown-tree';
import { invalidValueError } from '../errors';
import { CodeBlock } from './CodeBlock';
import type { HeadingLevel } from './heading-level';
import { headingTag } from './heading-level';
import { headingNode } from './heading-node';
import { Image } from './Image';
import { Link } from './Link';
import styles from './Markdown.module.scss';

/** What `resolveImage` answers for a source it vouches for: a box reserved, so no reflow. */
export interface ResolvedImage {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

export interface MarkdownRender {
  readonly baseLevel: number;
  readonly resolveImage?: ((src: string) => ResolvedImage | null) | undefined;
  readonly languages?: readonly Language[] | undefined;
  /** A heading's anchor id, when the caller asked for them (`headingIds`). */
  readonly ids?: ReadonlyMap<MarkdownBlock, string> | undefined;
}

const dimension = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** A remote image from model text is a tracking pixel: its alt, as a link, unless vouched for. */
function image(
  node: { readonly src: string; readonly alt: string },
  render: MarkdownRender,
): JSX.Element {
  const resolved = render.resolveImage?.(node.src) ?? null;
  if (resolved === null) {
    return <Link href={node.src}>{node.alt === '' ? node.src : node.alt}</Link>;
  }
  if (
    typeof resolved.src !== 'string' ||
    !dimension(resolved.width) ||
    !dimension(resolved.height)
  ) {
    throw invalidValueError(
      'Markdown resolveImage',
      resolved,
      '{ src: string, width: number, height: number } or null',
    );
  }
  return (
    <Image src={resolved.src} alt={node.alt} width={resolved.width} height={resolved.height} />
  );
}

export function inlineNodes(
  nodes: readonly MarkdownInline[],
  render: MarkdownRender,
): JSX.Element[] {
  return nodes.map((node) => inlineNode(node, render));
}

function inlineNode(node: MarkdownInline, render: MarkdownRender): JSX.Element {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'code':
      return <code class={styles['code']}>{node.text}</code>;
    case 'em':
      return <em>{inlineNodes(node.children, render)}</em>;
    case 'strong':
      return <strong>{inlineNodes(node.children, render)}</strong>;
    case 'del':
      return <del>{inlineNodes(node.children, render)}</del>;
    case 'link':
      return <Link href={node.href}>{inlineNodes(node.children, render)}</Link>;
    case 'image':
      return image(node, render);
    case 'break':
      return <br />;
  }
}

const level = (render: MarkdownRender, depth: number): HeadingLevel =>
  Math.min(6, render.baseLevel + depth - 1) as HeadingLevel;

export function blockNode(block: MarkdownBlock, render: MarkdownRender): JSX.Element {
  switch (block.kind) {
    case 'heading':
      return headingNode(
        headingTag(level(render, block.level)),
        { id: render.ids?.get(block), class: styles['heading'] },
        () => inlineNodes(block.children, render),
      );
    case 'paragraph':
      return <p>{inlineNodes(block.children, render)}</p>;
    case 'code':
      return <CodeBlock code={block.text} language={block.info} languages={render.languages} />;
    case 'quote':
      return (
        <blockquote class={styles['quote']}>
          {block.children.map((child) => blockNode(child, render))}
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((item) => (
        <li class={item.checked === null ? undefined : styles['task']}>
          {item.checked === null ? null : <input type="checkbox" checked={item.checked} disabled />}
          {/* A tight item's one paragraph is its text, not a <p>. */}
          {item.children.length === 1 && item.children[0]?.kind === 'paragraph'
            ? inlineNodes(item.children[0].children, render)
            : item.children.map((child) => blockNode(child, render))}
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table':
      return (
        <div class={styles['table']}>
          <table>
            <thead>
              <tr>
                {block.head.map((cell, c) => (
                  <th scope="col" data-align={block.align[c] ?? undefined}>
                    {inlineNodes(cell, render)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr>
                  {row.map((cell, c) => (
                    <td data-align={block.align[c] ?? undefined}>{inlineNodes(cell, render)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr />;
    case 'text':
      return <p class={styles['rest']}>{block.text}</p>;
  }
}
