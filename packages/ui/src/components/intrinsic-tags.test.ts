// Every `as` a layout or text primitive accepts renders exactly that element, and every heading
// level renders exactly that heading: each branch of the one-intrinsic-per-case switches is its own
// copy of the markup, so a typo in one case (`<section>` under `case 'aside'`) breaks only it.

import { describe, expect, test } from 'bun:test';
import { byTag, one, renderNodes } from '@ultimat3/core/render-nodes';
import { Card } from './Card';
import { Container } from './Container';
import { Grid } from './Grid';
import { HeatStrip } from './HeatStrip';
import { headingNode } from './heading-node';
import { Section } from './Section';
import { Stack } from './Stack';
import { Text } from './Text';

const root = (component: unknown, props: Record<string, unknown>) =>
  renderNodes(component, props)[0];

const CASES: readonly (readonly [string, unknown, readonly string[]])[] = [
  ['Stack', Stack, ['ul', 'ol', 'nav', 'section', 'header', 'footer', 'div']],
  ['Container', Container, ['main', 'section', 'article', 'header', 'footer', 'div']],
  ['Grid', Grid, ['ul', 'ol', 'section', 'div']],
  ['Text', Text, ['p', 'div', 'strong', 'em', 'span']],
  ['Card', Card, ['article', 'section', 'li', 'div']],
  ['Section', Section, ['article', 'aside', 'section']],
];

describe('each `as` renders that element, carrying its class and children', () => {
  for (const [name, component, tags] of CASES) {
    for (const tag of tags) {
      test(`${name} as="${tag}"`, () => {
        const node = root(component, { as: tag, children: 'body', class: 'mine' });
        expect(node?.type).toBe(tag);
        expect(String(node?.props['class'])).toContain('mine');
        expect(renderNodes(component, { as: tag, children: 'body' }).length).toBeGreaterThan(0);
      });
    }
  }

  test('a Card as="li" still renders its header, body and footer inside the item', () => {
    const nodes = renderNodes(Card, { as: 'li', header: 'h', footer: 'f', children: 'b' });
    expect(nodes[0]?.type).toBe('li');
    expect(byTag(nodes, 'div').map((div) => div.props['children'])).toEqual(['h', 'b', 'f']);
  });

  test('a titled Section as="aside" is named by its heading', () => {
    const nodes = renderNodes(Section, { as: 'aside', title: 'Filters', children: 'b' });
    const heading = one(byTag(nodes, 'h2'), '<h2>');
    expect(nodes[0]?.props['aria-labelledby']).toBe(heading.props['id']);
  });
});

describe('headingNode', () => {
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
    test(`${tag} renders <${tag}> with the id, class and content`, () => {
      const nodes = renderNodes(() => headingNode(tag, { id: 'x', class: 'c' }, () => 'Title'));
      const node = one(byTag(nodes, tag), `<${tag}>`);
      expect(node.props['id']).toBe('x');
      expect(node.props['class']).toBe('c');
      expect(node.props['children']).toBe('Title');
      expect(nodes).toHaveLength(1);
    });
  }
});

describe('HeatStrip', () => {
  const rows = [
    {
      label: 'api',
      cells: [
        { key: 't1', label: '12:00 — ok', tone: 'success' },
        { key: 't2', label: '12:05 — 3 failed', tone: 'danger', href: '/checks/t2' },
        { key: 't3', label: '12:10 — no data' },
      ],
    },
  ];

  test('an unlinked cell is a named img and no tab stop; a linked one is a link named by its text', () => {
    const nodes = renderNodes(HeatStrip, { label: 'Uptime', rows });
    const imgs = byTag(nodes, 'span').filter((node) => node.props['role'] === 'img');
    expect(imgs.map((node) => node.props['aria-label'])).toEqual([
      'api, 12:00 — ok',
      'api, 12:10 — no data',
    ]);
    expect(imgs.map((node) => node.props['data-shape'])).toEqual(['square', 'dash']);
    const link = one(byTag(nodes, 'a'), '<a>');
    expect(link.props['href']).toBe('/checks/t2');
    expect(link.props['data-shape']).toBe('cross');
    expect(link.props['aria-label']).toBeUndefined();
    expect(byTag(nodes, 'li')).toHaveLength(3);
    expect(one(byTag(nodes, 'ol'), '<ol>').props['aria-label']).toBe('api');
  });

  test('the caption names the figure, visible only when asked', () => {
    const hidden = one(byTag(renderNodes(HeatStrip, { label: 'Uptime', rows }), 'figcaption'), 'c');
    const shown = one(
      byTag(renderNodes(HeatStrip, { label: 'Uptime', rows, showCaption: true }), 'figcaption'),
      'c',
    );
    expect(hidden.props['children']).toBe('Uptime');
    expect(hidden.props['class']).not.toBe(shown.props['class']);
  });
});
