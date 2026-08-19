// The layout primitives carry no text and no state, so what breaks in them is invisible in a
// screenshot: the element they chose (`as`), the landmark wiring (`aria-labelledby` pointing at the
// heading it actually rendered), the separator role, and the space-scale custom property every
// stylesheet reads. Under `bun test` a `*.module.scss` import resolves to the file PATH, so a class
// name proves nothing here — these assert the props that survive that.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Card } from './Card';
import { Container } from './Container';
import { Divider } from './Divider';
import { Grid } from './Grid';
import { PageHeader } from './PageHeader';
import { Section } from './Section';
import { Stack } from './Stack';

const styleOf = (node: { props: Record<string, unknown> }): Record<string, string> =>
  node.props['style'] as Record<string, string>;

describe('the layout primitives', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('they compile to a JSX factory this file understands', () => {
    expect(renderNodes(Container, { children: 'body' }).length).toBeGreaterThan(0);
  });

  describe('Container', () => {
    test('renders a div unless asked for a landmark element', () => {
      expect(renderNodes(Container, { children: 'body' })[0]?.type).toBe('div');
      expect(renderNodes(Container, { children: 'body', as: 'main' })[0]?.type).toBe('main');
    });

    test('the gutter is a space-scale step, never a length', () => {
      expect(styleOf(renderNodes(Container, { children: 'x' })[0] as never)).toEqual({
        '--container-gutter': 'var(--space-4)',
      });
      expect(styleOf(renderNodes(Container, { children: 'x', gutter: 7 })[0] as never)).toEqual({
        '--container-gutter': 'var(--space-7)',
      });
    });
  });

  describe('Grid', () => {
    test('with no column count it is the intrinsic auto-fit grid', () => {
      const style = styleOf(renderNodes(Grid, { children: 'x' })[0] as never);
      expect(style['--grid-tracks']).toBe('repeat(auto-fit, minmax(16rem, 1fr))');
    });

    test('a column count switches to fixed tracks that may shrink below their content', () => {
      const style = styleOf(renderNodes(Grid, { children: 'x', columns: 3 })[0] as never);
      // `minmax(0, 1fr)` and not `1fr`: a fixed track whose min is `auto` refuses to shrink and
      // a long word overflows the grid instead of wrapping.
      expect(style['--grid-tracks']).toBe('repeat(3, minmax(0, 1fr))');
    });

    test('minColumn only reaches the intrinsic grid', () => {
      expect(
        styleOf(renderNodes(Grid, { children: 'x', minColumn: '20rem' })[0] as never)[
          '--grid-tracks'
        ],
      ).toBe('repeat(auto-fit, minmax(20rem, 1fr))');
    });

    test('the row gap follows the gap unless it is given its own step', () => {
      const followed = styleOf(renderNodes(Grid, { children: 'x', gap: 6 })[0] as never);
      expect(followed['--grid-gap']).toBe('var(--space-6)');
      expect(followed['--grid-row-gap']).toBe('var(--space-6)');

      const split = styleOf(renderNodes(Grid, { children: 'x', gap: 6, rowGap: 2 })[0] as never);
      expect(split['--grid-gap']).toBe('var(--space-6)');
      expect(split['--grid-row-gap']).toBe('var(--space-2)');
    });
  });

  describe('Stack', () => {
    test('align and justify are flexbox values, and their defaults differ', () => {
      const style = styleOf(renderNodes(Stack, { children: 'x' })[0] as never);
      // A stack that defaulted both to the same value would stretch or crowd every column layout.
      expect(style['--stack-align']).toBe('stretch');
      expect(style['--stack-justify']).toBe('flex-start');
    });

    test('the alias names map onto the CSS keywords they stand for', () => {
      const style = styleOf(
        renderNodes(Stack, { children: 'x', align: 'end', justify: 'between' })[0] as never,
      );
      expect(style['--stack-align']).toBe('flex-end');
      expect(style['--stack-justify']).toBe('space-between');
    });

    test('renders the semantic element it was asked for', () => {
      expect(renderNodes(Stack, { children: 'x', as: 'nav' })[0]?.type).toBe('nav');
    });
  });

  describe('Card', () => {
    test('a header or footer it was not given is not an empty box', () => {
      const bare = renderNodes(Card, { children: 'body' });
      // The outer element plus exactly one body wrapper.
      expect(byTag(bare, 'div')).toHaveLength(2);

      const full = renderNodes(Card, { children: 'body', header: 'h', footer: 'f' });
      expect(byTag(full, 'div')).toHaveLength(4);
      expect(byTag(full, 'div').map((node) => node.props['children'])).toEqual([
        expect.anything(),
        'h',
        'body',
        'f',
      ]);
    });

    test('padding is a space-scale step and the element is the one asked for', () => {
      const nodes = renderNodes(Card, { children: 'body', as: 'article', padding: 2 });
      expect(nodes[0]?.type).toBe('article');
      expect(styleOf(nodes[0] as never)['--card-padding']).toBe('var(--space-2)');
    });
  });

  describe('Divider', () => {
    test('with no caption it is an <hr> carrying its orientation', () => {
      const node = one(byTag(renderNodes(Divider, {}), 'hr'), 'rule');
      expect(node.props['aria-orientation']).toBe('horizontal');
      expect(renderNodes(Divider, { orientation: 'vertical' })[0]?.props['aria-orientation']).toBe(
        'vertical',
      );
    });

    test('a caption moves the role onto a container, because <hr> is void', () => {
      const nodes = renderNodes(Divider, { label: 'Danger zone', orientation: 'vertical' });
      expect(byTag(nodes, 'hr')).toEqual([]);

      const separator = one(withAttr(nodes, 'role', 'separator'), 'separator');
      expect(separator.type).toBe('div');
      expect(separator.props['aria-orientation']).toBe('vertical');
      expect(one(byTag(nodes, 'span'), 'caption').props['children']).toBe('Danger zone');
    });
  });

  describe('Section', () => {
    test('a titled section is a landmark named by the heading it rendered', () => {
      const nodes = renderNodes(Section, { children: 'body', title: 'Billing' });
      const region = nodes[0];
      expect(region?.type).toBe('section');

      const heading = one(byTag(nodes, 'h2'), 'section heading');
      expect(heading.props['children']).toBe('Billing');
      // The name has to point at the node that exists, not at an id nobody rendered.
      expect(region?.props['aria-labelledby']).toBe(heading.props['id']);
      expect(typeof heading.props['id']).toBe('string');
    });

    test('an untitled section claims no name and renders no head block', () => {
      const nodes = renderNodes(Section, { children: 'body' });
      expect(nodes[0]?.props['aria-labelledby']).toBeUndefined();
      // Outer element plus the body wrapper, and nothing between them.
      expect(nodes).toHaveLength(2);
    });

    test('actions alone still get a head block, with no heading in it', () => {
      const nodes = renderNodes(Section, { children: 'body', actions: 'controls' });
      expect(byTag(nodes, 'h2')).toEqual([]);
      expect(nodes.length).toBeGreaterThan(2);
    });

    test('the level is the caller’s, and 2 is the level under a PageHeader’s h1', () => {
      expect(byTag(renderNodes(Section, { children: 'b', title: 'T' }), 'h2')).toHaveLength(1);
      expect(
        byTag(renderNodes(Section, { children: 'b', title: 'T', level: 4 }), 'h4'),
      ).toHaveLength(1);
    });

    test('the description is flow text under the heading', () => {
      const nodes = renderNodes(Section, { children: 'b', title: 'T', description: 'why' });
      expect(one(byTag(nodes, 'p'), 'description').props['children']).toBe('why');
    });
  });

  describe('PageHeader', () => {
    test('the title is the page’s one h1 by default', () => {
      const nodes = renderNodes(PageHeader, { title: 'Invoices' });
      expect(nodes[0]?.type).toBe('header');
      expect(one(byTag(nodes, 'h1'), 'page heading').props['children']).toBe('Invoices');
    });

    test('a nested screen lowers its own level rather than rendering a second h1', () => {
      const nodes = renderNodes(PageHeader, { title: 'Invoices', level: 3 });
      expect(byTag(nodes, 'h1')).toEqual([]);
      expect(one(byTag(nodes, 'h3'), 'page heading').props['children']).toBe('Invoices');
    });

    test('breadcrumbs render the trail, and are absent when not supplied', () => {
      expect(byTag(renderNodes(PageHeader, { title: 'T' }), 'nav')).toEqual([]);

      const nodes = renderNodes(PageHeader, {
        title: 'Invoices',
        breadcrumbs: [{ label: 'Home', href: '/' }, { label: 'Invoices' }],
      });
      expect(byTag(nodes, 'nav')).toHaveLength(1);
      expect(withAttr(nodes, 'aria-current', 'page')).toHaveLength(1);
    });

    test('description and actions appear only when given', () => {
      const bare = renderNodes(PageHeader, { title: 'T' });
      expect(byTag(bare, 'p')).toEqual([]);

      const full = renderNodes(PageHeader, {
        title: 'T',
        description: 'all of them',
        actions: 'buttons',
        media: 'avatar',
      });
      expect(one(byTag(full, 'p'), 'description').props['children']).toBe('all of them');
      const divs = byTag(full, 'div').map((node) => node.props['children']);
      expect(divs).toContain('buttons');
      expect(divs).toContain('avatar');
    });
  });
});
