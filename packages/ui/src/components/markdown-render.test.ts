// Every block and inline kind the markdown tree carries, as the ELEMENT it becomes: emphasis,
// strong, strikethrough, code, hard breaks, quotes, ordered and task lists, aligned tables, rules,
// and the plain-text remainder past the size cap. The parse is `markdown-parse.test.ts`'s; this is
// `markdown-nodes.tsx` writing each kind out, and the parser corners only a render reaches.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import { byTag, one, type RenderNode, renderNodes } from '@ultimat3/core/render-nodes';
import { parseInline } from '../content/markdown-inline';
import { parseMarkdown } from '../content/markdown-parse';
import { MARKDOWN_MAX_CHARS } from '../content/markdown-tree';
import { Markdown } from './Markdown';

const render = (text: string, extra: Record<string, unknown> = {}): RenderNode[] =>
  renderNodes(Markdown, { text, ...extra });

const textOf = (node: RenderNode | undefined): string => {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (typeof value === 'function') visit((value as () => unknown)());
    else if (typeof value === 'object' && value !== null && 'props' in value) {
      visit((value as RenderNode).props['children']);
    }
  };
  visit(node?.props['children']);
  return out.join('');
};

describe('inline kinds', () => {
  test('em, strong, del and code each become their element, nested as written', () => {
    const nodes = render('*a* **b** ~~c~~ `d` ***e***');
    expect(byTag(nodes, 'em').map(textOf)).toContain('a');
    expect(byTag(nodes, 'strong').map(textOf)).toContain('b');
    expect(byTag(nodes, 'del').map(textOf)).toEqual(['c']);
    expect(byTag(nodes, 'code').map(textOf)).toEqual(['d']);
  });

  test('a trailing backslash is a hard <br>; a bare newline is not', () => {
    // Two trailing spaces break only in `parseInline`: the block parser trims them off the line
    // first, so in a rendered paragraph they never reach it (reported, not pinned here).
    expect(byTag(render('one\\\ntwo\nthree'), 'br')).toHaveLength(1);
    expect(byTag(render('one\ntwo'), 'br')).toHaveLength(0);
    expect(parseInline('one  \ntwo').map((node) => node.kind)).toEqual(['text', 'break', 'text']);
  });

  test('a vouched image reserves its box; an unvouched one is its alt as a link, or its src', () => {
    const vouched = render('![chart](/c.png)', {
      resolveImage: (src: string) => ({ src: `/cdn${src}`, width: 40, height: 30 }),
    });
    const img = one(byTag(vouched, 'img'), '<img>');
    expect([img.props['src'], img.props['width'], img.props['height']]).toEqual([
      '/cdn/c.png',
      40,
      30,
    ]);
    const bare = render('![](/c.png)', { resolveImage: () => null });
    expect(textOf(one(byTag(bare, 'a'), '<a>'))).toBe('/c.png');
  });

  test('a link with an <angle> destination and a title; a bare URL drops trailing punctuation', () => {
    const angle = parseInline('[x](<a b> "t") and (see https://ex.test/a_(b)).');
    const links = angle.filter((node) => node.kind === 'link');
    expect(links.map((node) => (node.kind === 'link' ? node.href : ''))).toEqual([
      'a b',
      'https://ex.test/a_(b)',
    ]);
  });

  test('an unclosed title or angle is no link at all', () => {
    expect(parseInline('[x](/a "t)').some((node) => node.kind === 'link')).toBe(false);
    expect(parseInline('[x](</a)').some((node) => node.kind === 'link')).toBe(false);
  });
});

describe('block kinds', () => {
  test('a quote holds its blocks; a rule is <hr>', () => {
    const nodes = render('> quoted *text*\n\n---');
    expect(textOf(one(byTag(nodes, 'blockquote'), 'quote'))).toBe('quoted text');
    expect(byTag(nodes, 'hr')).toHaveLength(1);
  });

  test('an ordered list keeps its start; a task item is a disabled checkbox carrying its state', () => {
    const ol = one(byTag(render('3. three\n4. four'), 'ol'), '<ol>');
    expect(ol.props['start']).toBe(3);
    const boxes = byTag(render('- [x] done\n- [ ] todo\n- plain'), 'input');
    expect(boxes.map((box) => [box.props['checked'], box.props['disabled']])).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  test('a loose item holds its paragraphs as blocks; a tight one is bare text', () => {
    const loose = render('- first\n\n  second\n- other');
    expect(byTag(loose, 'li').length).toBe(2);
    expect(byTag(loose, 'p').length).toBeGreaterThanOrEqual(2);
    expect(byTag(render('- only'), 'p')).toHaveLength(0);
  });

  test('a table: header cells scoped, alignment on head and body, an escaped pipe kept', () => {
    const nodes = render('| a | b | c |\n|:--|:-:|--:|\n| 1 \\| 2 | x | y |');
    const th = byTag(nodes, 'th');
    expect(th.map((cell) => cell.props['scope'])).toEqual(['col', 'col', 'col']);
    expect(th.map((cell) => cell.props['data-align'])).toEqual(['start', 'center', 'end']);
    const td = byTag(nodes, 'td');
    expect(textOf(td[0])).toBe('1 | 2');
    expect(td.map((cell) => cell.props['data-align'])).toEqual(['start', 'center', 'end']);
  });

  test('a heading with code, an image and a break still yields a plain anchor', () => {
    const nodes = render('# `x` ![pic](/p.png) end', { headingIds: true });
    expect(one(byTag(nodes, 'h2'), '<h2>').props['id']).toBe('x-pic-end');
  });

  test('past the size cap the rest is one plain-text paragraph', () => {
    const body = `${'a\n'.repeat(MARKDOWN_MAX_CHARS / 2)}tail *not emphasis*`;
    const blocks = parseMarkdown(body);
    expect(blocks.at(-1)).toEqual({ kind: 'text', text: 'tail *not emphasis*' });
    const nodes = render(body);
    expect(textOf(byTag(nodes, 'p').at(-1))).toBe('tail *not emphasis*');
    expect(byTag(nodes, 'em')).toHaveLength(0);
  });
});
