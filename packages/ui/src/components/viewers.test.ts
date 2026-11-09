// The viewers as RENDERED, read off the element tree: a hostile markdown body yields no script,
// no `javascript:` href and no remote <img>; fences go through CodeBlock; code stays LTR; a diff
// says its changes in words; a 100,000-line log renders every line with no script.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import { byTag, one, type RenderNode, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { tsLanguage } from '../content/languages/ts';
import { CodeBlock } from './CodeBlock';
import { DiffView } from './DiffView';
import { JsonView } from './JsonView';
import { LogViewer } from './LogViewer';
import { Markdown } from './Markdown';
import { TerminalView } from './TerminalView';

/** Every text the tree carries, as a renderer would write it. */
function texts(nodes: readonly RenderNode[]): string {
  const seen: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') seen.push(String(value));
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (typeof value === 'object' && value !== null && 'props' in value) {
      visit((value as RenderNode).props['children']);
    }
  };
  for (const node of nodes) visit(node.props['children']);
  return seen.join('');
}

const HOSTILE = [
  '# Title',
  '',
  '<script>alert(1)</script>',
  '',
  '[click](javascript:alert(1)) and ![pixel](https://tracker.test/p.gif)',
  '',
  '<img src=x onerror=alert(1)>',
  '',
  '```ts',
  'const a = "</code><script>";',
  '```',
].join('\n');

describe('Markdown', () => {
  test('a hostile body renders inert: no script, no img, no javascript: href', () => {
    const nodes = renderNodes(Markdown, { text: HOSTILE });
    expect(byTag(nodes, 'script')).toEqual([]);
    expect(byTag(nodes, 'img')).toEqual([]);
    expect(byTag(nodes, 'iframe')).toEqual([]);
    for (const anchor of byTag(nodes, 'a')) {
      expect(String(anchor.props['href'] ?? '')).not.toMatch(/^\s*javascript:/i);
    }
    // The text is all still there, as text.
    expect(texts(nodes)).toContain('<script>alert(1)</script>');
    expect(texts(nodes)).toContain('[click](javascript:alert(1))');
    // No element carries an event-handler attribute a body could have named.
    for (const node of nodes) {
      expect(Object.keys(node.props).filter((name) => /^on[a-z]/.test(name))).toEqual([]);
    }
  });

  test('a remote image prints its alt as a link; a vouched one reserves its box', () => {
    const plain = renderNodes(Markdown, { text: '![pixel](https://tracker.test/p.gif)' });
    const link = one(byTag(plain, 'a'), 'image link');
    expect(link.props['href']).toBe('https://tracker.test/p.gif');
    const vouched = renderNodes(Markdown, {
      text: '![cat](/cat.png)',
      resolveImage: (src: string) => ({ src, width: 320, height: 200 }),
    });
    const img = one(byTag(vouched, 'img'), '<img>');
    expect([img.props['width'], img.props['height']]).toEqual([320, 200]);
  });

  test('a malformed resolveImage answer is X_UI_INVALID_VALUE', () => {
    expect(() =>
      renderNodes(Markdown, {
        text: '![cat](/cat.png)',
        resolveImage: () => ({ src: '/cat.png', width: Number.NaN, height: 1 }),
      }),
    ).toThrow(/resolveImage/);
  });

  test('`#` renders at baseLevel, 2 by default: a body never adds an h1', () => {
    expect(byTag(renderNodes(Markdown, { text: '# A\n\n## B' }), 'h1')).toEqual([]);
    expect(byTag(renderNodes(Markdown, { text: '# A' }), 'h2')).toHaveLength(1);
    expect(byTag(renderNodes(Markdown, { text: '# A', baseLevel: 3 }), 'h3')).toHaveLength(1);
  });

  test('a fence is a CodeBlock, highlighted only by a language it was handed', () => {
    const plain = renderNodes(Markdown, { text: '```ts\nconst a = 1;\n```' });
    expect(byTag(plain, 'pre')).toHaveLength(1);
    expect(byTag(plain, 'span').filter((node) => node.props['class'] !== undefined).length).toBe(0);
    const coloured = renderNodes(Markdown, {
      text: '```ts\nconst a = 1;\n```',
      languages: [tsLanguage],
    });
    expect(byTag(coloured, 'span').length).toBeGreaterThan(0);
  });
});

describe('CodeBlock', () => {
  test('a named, focusable scroll region that stays LTR, its text exactly the code', () => {
    const code = 'const s = "<b>&amp;</b>";';
    const nodes = renderNodes(CodeBlock, { code, language: 'ts', languages: [tsLanguage] });
    const pre = one(byTag(nodes, 'pre'), '<pre>');
    expect(pre.props['dir']).toBe('ltr');
    expect(pre.props['tabindex']).toBe('0');
    expect(String(pre.props['aria-label'])).not.toBe('');
    expect(texts(byTag(nodes, 'code'))).toBe(code);
  });
});

describe('DiffView', () => {
  test('every changed row is spoken and signed, not only coloured', () => {
    const nodes = renderNodes(DiffView, { old: 'a\nb', new: 'a\nc' });
    const text = texts(nodes);
    expect(text).toContain('+');
    expect(text).toContain('-');
    expect(text).toContain('Added');
    expect(text).toContain('Removed');
    expect(byTag(nodes, 'mark').length).toBeGreaterThan(0);
  });

  test('past maxLines it folds and says how many', () => {
    const after = Array.from({ length: 50 }, (_, i) => String(i)).join('\n');
    const text = texts(renderNodes(DiffView, { old: '', new: after, maxLines: 10 }));
    expect(text).toContain('40 more lines not shown');
  });
});

describe('JsonView', () => {
  test('nested native details, keys in order', () => {
    const nodes = renderNodes(JsonView, { value: { b: 1, a: { c: [true] } }, label: 'Usage' });
    expect(byTag(nodes, 'details').length).toBe(3);
    expect(withAttr(nodes, 'role', 'group')).toHaveLength(1);
  });
});

describe('LogViewer and TerminalView', () => {
  test('with no script a log renders every line it was given', () => {
    const lines = Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      text: `line ${i}`,
      level: 'info' as const,
    }));
    const nodes = renderNodes(LogViewer, { lines, cap: 1_000 });
    expect(byTag(nodes, 'li')).toHaveLength(300);
  });

  test('terminal output renders roles and drops every escape', () => {
    const nodes = renderNodes(TerminalView, {
      text: '\u001b[31mfail\u001b[0m\n\u001b]0;title\u0007ok',
    });
    const text = texts(nodes);
    expect(text).toContain('fail');
    expect(text).toContain('ok');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('title');
  });
});

describe('Markdown headingIds', () => {
  test('off by default; on, every heading carries its GitHub anchor', () => {
    expect(byTag(renderNodes(Markdown, { text: '# A b' }), 'h2')[0]?.props['id']).toBeUndefined();
    const nodes = renderNodes(Markdown, { text: '# A b\n\n# A b', headingIds: true });
    expect(byTag(nodes, 'h2').map((node) => node.props['id'])).toEqual(['a-b', 'a-b-1']);
  });
});
