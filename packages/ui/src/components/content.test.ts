// Two components whose rules live in a pure module beside them (`link-target`, `accordion-view`)
// — already tested there; `Image`'s wiring is `Image.test.ts`. What is NOT tested there is the
// wiring: whether the component asks the rule, and whether the answer reaches the element. A
// `javascript:` href refused by `linkTarget` and then emitted anyway by `<Link>` passes every test
// the helper has.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, fire, one, type ProbeNode, probe, renderNodes, unprobe } from '../jsx-probe';
import { Accordion } from './Accordion';
import { Link, type LinkProps } from './Link';

describe('the content components', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('they compile to a JSX factory this file understands', () => {
    expect(renderNodes(Link, { href: '/', children: 'Home' }).length).toBeGreaterThan(0);
  });

  describe('Link', () => {
    test('an internal link gets neither a target nor a rel', () => {
      const node = one(byTag(renderNodes(Link, { href: '/docs', children: 'Docs' }), 'a'), 'link');
      expect(node.props['href']).toBe('/docs');
      expect(node.props['target']).toBeUndefined();
      expect(node.props['rel']).toBeUndefined();
    });

    test('an absolute http(s) href is external without being declared one', () => {
      const node = one(
        byTag(renderNodes(Link, { href: 'https://lucide.dev', children: 'Lucide' }), 'a'),
        'link',
      );
      expect(node.props['target']).toBe('_blank');
      expect(node.props['rel']).toBe('noopener noreferrer');
    });

    test('a declared external link is hardened even on a same-origin path', () => {
      const node = one(
        byTag(renderNodes(Link, { href: '/legacy', external: true, children: 'Legacy' }), 'a'),
        'link',
      );
      expect(node.props['target']).toBe('_blank');
      expect(node.props['rel']).toBe('noopener noreferrer');
    });

    test('a scheme the browser would execute emits no href, and never becomes external', () => {
      const node = one(
        byTag(
          renderNodes(Link, { href: 'javascript:alert(1)', external: true, children: 'Click' }),
          'a',
        ),
        'link',
      );
      expect(node.props['href']).toBeUndefined();
      // The refused value must not pick up `target="_blank"` on the way out either.
      expect(node.props['target']).toBeUndefined();
      expect(node.props['rel']).toBeUndefined();
      // Inert, but still readable: the text is the caller's and stays.
      expect(node.props['children']).toEqual(['Click', null]);
    });

    test('the external hint is announced only where the link really is external', () => {
      const external = renderNodes(Link, {
        href: 'https://lucide.dev',
        externalHint: 'opens in a new tab',
        children: 'Lucide',
      });
      expect(one(byTag(external, 'span'), 'hint').props['children']).toBe('opens in a new tab');

      const internal = renderNodes(Link, {
        href: '/docs',
        externalHint: 'opens in a new tab',
        children: 'Docs',
      });
      expect(byTag(internal, 'span')).toEqual([]);
    });
  });

  describe('Link appearance="button"', () => {
    const look = { appearance: 'button', variant: 'secondary', size: 'sm' };

    test('is an anchor with the href, never a button element', () => {
      const nodes = renderNodes(Link, { ...look, href: '/posts/new', children: 'New post' });
      expect(one(byTag(nodes, 'a'), 'link').props['href']).toBe('/posts/new');
      expect(byTag(nodes, 'button')).toEqual([]);
    });

    test('navigates on its own: no handler unless the caller passed one', () => {
      const node = one(byTag(renderNodes(Link, { ...look, href: '/x', children: 'Go' }), 'a'), 'a');
      expect(node.props['onClick']).toBeUndefined();
    });

    // Button wraps its label so a long one truncates inside the padding, with the icons outside
    // the truncated run. The same look on an anchor needs the same three children.
    test('wraps its label and places the icons exactly as Button does', () => {
      const nodes = renderNodes(Link, {
        ...look,
        href: '/x',
        iconStart: 'S',
        iconEnd: 'E',
        children: 'Label',
      });
      const anchor = one(byTag(nodes, 'a'), 'link');
      const label = one(byTag(nodes, 'span'), 'label');
      expect(label.props['children']).toBe('Label');
      expect(anchor.props['children']).toEqual([['S', label, 'E'], null]);
    });

    test('a refused scheme is still refused: the look does not buy an href', () => {
      const nodes = renderNodes(Link, { ...look, href: 'javascript:alert(1)', children: 'Go' });
      expect(one(byTag(nodes, 'a'), 'link').props['href']).toBeUndefined();
    });

    test('an external button-link is hardened and announced like any other', () => {
      const nodes = renderNodes(Link, {
        ...look,
        href: 'https://lucide.dev',
        externalHint: 'opens in a new tab',
        children: 'Lucide',
      });
      const anchor = one(byTag(nodes, 'a'), 'link');
      expect(anchor.props['target']).toBe('_blank');
      expect(anchor.props['rel']).toBe('noopener noreferrer');
      expect(byTag(nodes, 'span').map((node) => node.props['children'])).toEqual([
        'Lucide',
        'opens in a new tab',
      ]);
    });
  });

  /**
   * Two looks, two prop sets, held by the type: each directive is red the day `LinkProps` stops
   * refusing the pairing beneath it (`scripts/test-typecheck-gate.ts` compiles this file).
   */
  test("a look takes its own props and refuses the other look's", () => {
    const to = { href: '/', children: 'x' } as const;
    // @ts-expect-error `variant` is a button-link prop; a text link has no variant
    const textWithVariant: LinkProps = { ...to, variant: 'ghost' };
    // @ts-expect-error `underline` is a text-link prop; a button-link is never underlined by it
    const buttonUnderlined: LinkProps = { ...to, appearance: 'button', underline: 'always' };
    // @ts-expect-error `inherit` is a text-link tone; a button-link takes a `Tone`
    const buttonInherit: LinkProps = { ...to, appearance: 'button', tone: 'inherit' };
    const text: LinkProps = { ...to, tone: 'inherit', underline: 'none' };
    const button: LinkProps = { ...to, appearance: 'button', tone: 'danger' };
    expect([textWithVariant, buttonUnderlined, buttonInherit, text, button]).toHaveLength(5);
  });

  test('a text link carries a pager relation when it is given one', () => {
    const node = one(
      byTag(renderNodes(Link, { href: '/p/2', rel: 'next', children: '2' }), 'a'),
      'a',
    );
    expect(node.props['rel']).toBe('next');
  });

  describe('Accordion', () => {
    const items = [
      { id: 'one', title: 'First', panel: 'p1', defaultOpen: true },
      { id: 'two', title: 'Second', panel: 'p2', defaultOpen: true },
      { id: 'three', title: 'Third', panel: 'p3' },
    ];

    test('open state is a real attribute, so a section is expanded with no script', () => {
      const details = byTag(renderNodes(Accordion, { items }), 'details');
      expect(details.map((node) => node.props['open'])).toEqual([true, true, false]);
      expect(details.map((node) => node.props['name'])).toEqual([undefined, undefined, undefined]);
    });

    test('exclusive groups the sections natively and keeps only the first open', () => {
      const details = byTag(renderNodes(Accordion, { items, exclusive: true }), 'details');
      const names = details.map((node) => node.props['name']);

      expect(details.map((node) => node.props['open'])).toEqual([true, false, false]);
      expect(new Set(names).size).toBe(1);
      expect(typeof names[0]).toBe('string');
    });

    test('element ids are distinct and derived from the item ids', () => {
      const ids = byTag(renderNodes(Accordion, { items }), 'details').map(
        (node) => node.props['id'] as string,
      );
      expect(new Set(ids).size).toBe(3);
      expect(ids.map((id) => id.split('-').at(-1))).toEqual(['one', 'two', 'three']);
    });

    test('a duplicate item id is refused, because ids become element ids', () => {
      expect(() =>
        renderNodes(Accordion, {
          items: [
            { id: 'one', title: 'a', panel: 'x' },
            { id: 'one', title: 'b', panel: 'y' },
          ],
        }),
      ).toThrow(expect.objectContaining({ code: 'X_UI_INVALID_VALUE' }));
    });

    test('the title is plain text unless a heading level puts it in the outline', () => {
      const plain = renderNodes(Accordion, { items });
      expect(byTag(plain, 'h3')).toEqual([]);

      const outlined = byTag(renderNodes(Accordion, { items, level: 3 }), 'h3');
      expect(outlined.map((node) => node.props['children'])).toEqual(['First', 'Second', 'Third']);
    });

    test('onToggle reports the item and the state the browser already applied', () => {
      const seen: [string, boolean][] = [];
      const nodes = renderNodes(Accordion, {
        items,
        onToggle: (id: string, open: boolean) => seen.push([id, open]),
      });

      const second = one([byTag(nodes, 'details')[1] as ProbeNode], 'the second section');
      fire(second, 'onToggle', { currentTarget: { open: false } });
      expect(seen).toEqual([['two', false]]);
    });

    test('the disclosure marker is the chevron glyph, decorative', () => {
      const nodes = renderNodes(Accordion, { items });
      const markers = byTag(nodes, 'svg');
      expect(markers).toHaveLength(3);
      expect(markers.map((node) => node.props['aria-hidden'])).toEqual(['true', 'true', 'true']);
      // The glyph really rendered its path rather than an empty <svg>.
      expect(byTag(nodes, 'path')).toHaveLength(3);
    });
  });
});
