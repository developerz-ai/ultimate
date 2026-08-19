// What breaks in a presentational component is never the pixels — it is the accessible name it
// forgot, the decoration it read out loud, or the string it hardcoded instead of resolving through
// the catalog. Outside a request the translator is the loud-miss one, so a resolved key renders as
// `⟦ui.loading⟧`: a component that wrote its own English would render the English.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UI_KEYS } from '../i18n-keys';
import { byTag, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Avatar, initialsOf } from './Avatar';
import { Badge } from './Badge';
import { Skeleton } from './Skeleton';
import { Spinner } from './Spinner';
import { Text } from './Text';
import { Tooltip } from './Tooltip';

const styleOf = (node: { props: Record<string, unknown> }): Record<string, string> =>
  node.props['style'] as Record<string, string>;

describe('the presentational primitives', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('they compile to a JSX factory this file understands', () => {
    expect(renderNodes(Badge, { children: 'New' }).length).toBeGreaterThan(0);
  });

  describe('Badge', () => {
    test('renders its already-translated children inside a span', () => {
      const nodes = renderNodes(Badge, { children: 'Overdue' });
      expect(nodes[0]?.type).toBe('span');
      expect(nodes).toHaveLength(1);
      // No dot: the slot is empty, not an empty element.
      expect(nodes[0]?.props['children']).toEqual([null, 'Overdue']);
    });

    test('the dot is decoration, so it is hidden rather than announced as a bullet', () => {
      const nodes = renderNodes(Badge, { children: 'Overdue', dot: true, tone: 'danger' });
      const dot = one(withAttr(nodes, 'aria-hidden', 'true'), 'badge dot');
      expect(dot.type).toBe('span');
      // The label still reaches the accessibility tree beside it.
      expect(nodes[0]?.props['children']).toEqual([dot, 'Overdue']);
    });
  });

  describe('Text', () => {
    test('is an inline span unless a semantic element is asked for', () => {
      expect(renderNodes(Text, { children: 'hi' })[0]?.type).toBe('span');
      // `strong` and `em` carry meaning; `weight` and `tone` do not.
      expect(renderNodes(Text, { children: 'hi', as: 'strong' })[0]?.type).toBe('strong');
    });

    test('an unset size or weight sets no custom property, so it inherits', () => {
      expect(styleOf(renderNodes(Text, { children: 'hi' })[0] as never)).toEqual({});
    });

    test('a set size or weight resolves to its own token, one property each', () => {
      expect(styleOf(renderNodes(Text, { children: 'hi', size: 'sm' })[0] as never)).toEqual({
        '--text-scale': 'var(--text-sm)',
      });
      expect(styleOf(renderNodes(Text, { children: 'hi', weight: 'bold' })[0] as never)).toEqual({
        '--text-strength': 'var(--weight-bold)',
      });
    });
  });

  describe('Skeleton', () => {
    test('the whole placeholder is hidden — a screen reader hears nothing, not "blank"', () => {
      const nodes = renderNodes(Skeleton, {});
      expect(nodes[0]?.props['aria-hidden']).toBe('true');
    });

    test('renders one line per requested line, and never fewer than one', () => {
      expect(renderNodes(Skeleton, { lines: 3 })).toHaveLength(4);
      expect(renderNodes(Skeleton, { lines: 0 })).toHaveLength(2);
      expect(renderNodes(Skeleton, {})).toHaveLength(2);
    });

    test('the trailing lines are short, the way a real last line of a paragraph is', () => {
      const widths = renderNodes(Skeleton, { lines: 3 })
        .slice(1)
        .map((node) => styleOf(node)['--skeleton-w']);
      expect(widths).toEqual(['100%', '70%', '70%']);
    });

    test('a circle keeps the caller’s box on every line — a 70% circle is an ellipse', () => {
      const widths = renderNodes(Skeleton, { lines: 2, shape: 'circle', width: '3rem' })
        .slice(1)
        .map((node) => styleOf(node)['--skeleton-w']);
      expect(widths).toEqual(['3rem', '3rem']);
    });

    test('the height is the caller’s, so the real content lands in the same box', () => {
      expect(styleOf(renderNodes(Skeleton, { height: '4rem' })[1] as never)).toEqual({
        '--skeleton-w': '100%',
        '--skeleton-h': '4rem',
      });
    });
  });

  describe('Spinner', () => {
    test('has a live status role and a name resolved through the catalog', () => {
      const node = one(withAttr(renderNodes(Spinner, {}), 'role', 'status'), 'spinner');
      expect(node.props['aria-live']).toBe('polite');
      expect(node.props['aria-label']).toContain(UI_KEYS.loading);
      expect(node.props['aria-hidden']).toBeUndefined();
    });

    test('an explicit label overrides the catalog default', () => {
      expect(renderNodes(Spinner, { label: 'Saving…' })[0]?.props['aria-label']).toBe('Saving…');
    });

    test('decorative drops the role AND the name — a parent already announces busy', () => {
      const nodes = renderNodes(Spinner, { decorative: true });
      expect(withAttr(nodes, 'role')).toEqual([]);
      expect(nodes[0]?.props['aria-hidden']).toBe('true');
      expect(nodes[0]?.props['aria-label']).toBeUndefined();
    });
  });

  describe('Avatar', () => {
    test('initials are the first letters of the first two words, and never ASCII-only', () => {
      expect(initialsOf('Ada Lovelace King')).toBe('AL');
      expect(initialsOf('  mira  ')).toBe('M');
      expect(initialsOf('Ólafur Þór')).toBe('ÓÞ');
      // A grapheme past the BMP must not be sliced in half by a `[0]` on the string.
      expect(initialsOf('𝔄da')).toBe('𝔄');
      expect(initialsOf('')).toBe('');
    });

    test('with no image it renders hidden initials and the name as text', () => {
      const nodes = renderNodes(Avatar, { name: 'Ada Lovelace' });
      expect(byTag(nodes, 'img')).toEqual([]);
      expect(one(withAttr(nodes, 'aria-hidden', 'true'), 'initials').props['children']).toBe('AL');
      // The name is a real text node, so the chip is not named by the initials.
      expect(byTag(nodes, 'span').map((node) => node.props['children'])).toContain('Ada Lovelace');
    });

    test('the image carries intrinsic dimensions matching the size token, and an empty alt', () => {
      const img = one(byTag(renderNodes(Avatar, { name: 'Ada', src: '/a.png' }), 'img'), 'avatar');
      expect(img.props['alt']).toBe('');
      expect(img.props['width']).toBe(32);
      expect(img.props['height']).toBe(32);
      expect(img.props['loading']).toBe('lazy');

      const large = one(
        byTag(renderNodes(Avatar, { name: 'Ada', src: '/a.png', size: 'xl' }), 'img'),
        'avatar',
      );
      expect(large.props['width']).toBe(64);
      expect(styleOf(renderNodes(Avatar, { name: 'Ada', size: 'xl' })[0] as never)).toEqual({
        '--avatar-size': '64px',
      });
    });

    test('a src the URL guard refuses emits no src at all', () => {
      const img = one(
        byTag(renderNodes(Avatar, { name: 'Ada', src: 'javascript:alert(1)' }), 'img'),
        'avatar',
      );
      expect(img.props['src']).toBeUndefined();
    });
  });

  describe('Tooltip', () => {
    test('the bubble is described-by wired to the control, never a title attribute', () => {
      let handed: string | undefined;
      const nodes = renderNodes(Tooltip, {
        content: 'Applies to future invoices only',
        children: (control: { 'aria-describedby': string }) => {
          handed = control['aria-describedby'];
          return null;
        },
      });

      const bubble = one(withAttr(nodes, 'role', 'tooltip'), 'tooltip bubble');
      expect(bubble.props['children']).toBe('Applies to future invoices only');
      expect(typeof handed).toBe('string');
      expect(bubble.props['id']).toBe(handed);
      expect(withAttr(nodes, 'title')).toEqual([]);
    });
  });
});
