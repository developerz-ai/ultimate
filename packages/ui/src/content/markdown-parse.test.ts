// What a model's text can and cannot become: raw HTML is text, a `javascript:` link is text, a
// hostile 100 KB body parses under a ceiling, and the caps hold. Plus the working set itself.

import { describe, expect, test } from 'bun:test';
import { parseInline, safeMarkdownUrl } from './markdown-inline';
import { parseMarkdown } from './markdown-parse';
import {
  MARKDOWN_MAX_BLOCK_DEPTH,
  MARKDOWN_MAX_CHARS,
  MARKDOWN_MAX_INLINE_DEPTH,
  type MarkdownBlock,
  type MarkdownInline,
} from './markdown-tree';

/** Every string the tree carries, in order — what a renderer could ever emit as text. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

const kinds = (nodes: readonly (MarkdownBlock | MarkdownInline)[]): string[] =>
  nodes.map((node) => node.kind);

describe('hostile input', () => {
  test('<script> is six characters of text, not an element', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>');
    expect(blocks).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '<script>alert(1)</script>' }] },
    ]);
  });

  test('an HTML block is a paragraph of text, attributes and all', () => {
    const [block] = parseMarkdown('<img src=x onerror="alert(1)">');
    expect(block?.kind).toBe('paragraph');
    expect(strings(block).join('')).toContain('onerror');
  });

  test('a javascript: link prints as its source and links nowhere', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
    ]) {
      const inline = parseInline(`[click](${href})`);
      expect(kinds(inline)).toEqual(['text']);
      expect(JSON.stringify(inline)).not.toContain('"link"');
    }
  });

  test('an unsafe image source is text too', () => {
    expect(kinds(parseInline('![x](javascript:alert(1))'))).toEqual(['text']);
  });

  test('only http, https, mailto and relative destinations are followed', () => {
    expect(safeMarkdownUrl('https://example.com')).toBe(true);
    expect(safeMarkdownUrl('mailto:a@b.c')).toBe(true);
    expect(safeMarkdownUrl('/docs#x')).toBe(true);
    expect(safeMarkdownUrl('tel:123')).toBe(false);
    expect(safeMarkdownUrl(' \u0001javascript:x')).toBe(false);
  });

  test('100 KB of * and [ parses under a time ceiling', () => {
    for (const unit of ['*', '[', '*[', '[*_~`', '[](', '**a', '![', '<http:', '\\*']) {
      const body = unit.repeat(Math.ceil(100_000 / unit.length));
      const began = performance.now();
      const blocks = parseMarkdown(body);
      expect(performance.now() - began).toBeLessThan(1_000);
      expect(strings(blocks).join('').length).toBeGreaterThan(0);
    }
  });

  test('100 KB of nested quote and list markers is capped, never a stack overflow', () => {
    for (const line of ['> '.repeat(5_000), '- '.repeat(5_000)]) {
      const began = performance.now();
      const blocks = parseMarkdown(`${line}x`);
      expect(performance.now() - began).toBeLessThan(1_000);
      let depth = 0;
      let at: unknown = blocks[0];
      while (typeof at === 'object' && at !== null && ('children' in at || 'items' in at)) {
        depth += 1;
        const node = at as { children?: unknown[]; items?: { children: unknown[] }[] };
        at = node.children?.[0] ?? node.items?.[0]?.children[0];
      }
      expect(depth).toBeLessThanOrEqual(MARKDOWN_MAX_BLOCK_DEPTH * 2);
    }
  });

  test('nested links stop at the inline cap and keep the rest as text', () => {
    const body = `${'['.repeat(5_000)}x${'](/u)'.repeat(5_000)}`;
    const depthOf = (nodes: readonly MarkdownInline[]): number =>
      Math.max(0, ...nodes.map((node) => ('children' in node ? 1 + depthOf(node.children) : 0)));
    const inline = parseInline(body);
    expect(depthOf(inline)).toBeLessThanOrEqual(MARKDOWN_MAX_INLINE_DEPTH + 1);
    expect(strings(inline).join('')).toContain('x');
  });

  test('past the size cap the remainder is one plain-text block', () => {
    const body = `${'line\n'.repeat(MARKDOWN_MAX_CHARS / 5)}# tail`;
    const blocks = parseMarkdown(body);
    expect(blocks.at(-1)).toEqual({ kind: 'text', text: expect.stringContaining('# tail') });
  });
});

describe('the working set', () => {
  test('headings, emphasis, code and strikethrough', () => {
    const [heading, para] = parseMarkdown('## Title\n\nSome **bold**, *em*, `code` and ~~gone~~.');
    expect(heading).toEqual({
      kind: 'heading',
      level: 2,
      children: [{ kind: 'text', text: 'Title' }],
    });
    expect(kinds((para as unknown as { children: MarkdownInline[] }).children)).toEqual([
      'text',
      'strong',
      'text',
      'em',
      'text',
      'code',
      'text',
      'del',
      'text',
    ]);
  });

  test('setext headings', () => {
    expect(parseMarkdown('Title\n===')[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(parseMarkdown('Title\n---')[0]).toMatchObject({ kind: 'heading', level: 2 });
  });

  test('fences keep their text verbatim and an unclosed one stays open', () => {
    expect(parseMarkdown('```ts\nconst a = "<b>";\n```')[0]).toEqual({
      kind: 'code',
      info: 'ts',
      text: 'const a = "<b>";',
      open: false,
    });
    expect(parseMarkdown('```sh\nls')[0]).toEqual({
      kind: 'code',
      info: 'sh',
      text: 'ls',
      open: true,
    });
  });

  test('nested and task lists', () => {
    const [list] = parseMarkdown('- [x] done\n- [ ] todo\n  - child\n- plain');
    expect(list).toMatchObject({ kind: 'list', ordered: false });
    const items = (
      list as unknown as { items: { checked: boolean | null; children: MarkdownBlock[] }[] }
    ).items;
    expect(items.map((item) => item.checked)).toEqual([true, false, null]);
    expect(kinds(items[1]?.children ?? [])).toEqual(['paragraph', 'list']);
  });

  test('ordered lists keep their start', () => {
    expect(parseMarkdown('3. c\n4. d')[0]).toMatchObject({ kind: 'list', ordered: true, start: 3 });
  });

  test('tables with alignment', () => {
    const [table] = parseMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |');
    expect(table).toMatchObject({ kind: 'table', align: ['start', 'end'] });
    expect((table as unknown as { rows: unknown[][] }).rows).toHaveLength(2);
  });

  test('quotes and rules', () => {
    expect(kinds(parseMarkdown('> quoted\n\n---'))).toEqual(['quote', 'rule']);
  });

  test('links, autolinks and images', () => {
    const inline = parseInline(
      '[a](https://x.test "T") <https://y.test> www.z.test, ![alt](/i.png)',
    );
    expect(
      inline.filter((node) => node.kind === 'link').map((node) => (node as { href: string }).href),
    ).toEqual(['https://x.test', 'https://y.test', 'https://www.z.test']);
    expect(inline.find((node) => node.kind === 'image')).toEqual({
      kind: 'image',
      src: '/i.png',
      alt: 'alt',
    });
  });

  test('a backslash escapes and two trailing spaces break', () => {
    expect(parseInline('\\*not em\\*')).toEqual([{ kind: 'text', text: '*not em*' }]);
    expect(kinds(parseInline('a  \nb'))).toEqual(['text', 'break', 'text']);
  });

  test('snake_case is not emphasis', () => {
    expect(parseInline('a_b_c')).toEqual([{ kind: 'text', text: 'a_b_c' }]);
  });
});
