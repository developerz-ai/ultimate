// The trail's one structural guarantee: exactly one `aria-current="page"`, on the LAST item. An
// href-less ancestor is still an ancestor — two `aria-current="page"` elements in one `<nav>` make
// a screen reader announce the current page twice, on the wrong node first.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Breadcrumb } from './Breadcrumb';

const trail = (items: readonly Record<string, unknown>[]): Record<string, unknown> => ({ items });

describe('Breadcrumb', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the component compiles to a JSX factory this file understands', () => {
    expect(renderNodes(Breadcrumb, trail([{ label: 'Home', href: '/' }])).length).toBeGreaterThan(
      0,
    );
  });

  test('an href-less ancestor does not claim to be the current page', () => {
    const nodes = renderNodes(
      Breadcrumb,
      trail([{ label: 'Home' }, { label: 'Docs', href: '/docs' }, { label: 'Current' }]),
    );
    const current = withAttr(nodes, 'aria-current', 'page');
    expect(current.length).toBe(1);
    expect(current[0]?.props['children']).toBe('Current');
  });

  test('an href-less ancestor renders as plain text, never as a link', () => {
    const nodes = renderNodes(
      Breadcrumb,
      trail([{ label: 'Home' }, { label: 'Current', href: '/here' }]),
    );
    expect(byTag(nodes, 'a').map((node) => node.props['children'])).toEqual([]);
    const spans = byTag(nodes, 'span');
    expect(spans.map((node) => node.props['children'])).toEqual(['Home', 'Current']);
    expect(spans[0]?.props['aria-current']).toBeUndefined();
  });

  test('the last item is the current page even when it carries an href', () => {
    const nodes = renderNodes(
      Breadcrumb,
      trail([
        { label: 'Home', href: '/' },
        { label: 'Docs', href: '/docs' },
      ]),
    );
    const current = one(withAttr(nodes, 'aria-current', 'page'), 'current-page element');
    expect(current.props['children']).toBe('Docs');
    // The final item is text even with an href: a link to the page you are on is a dead control.
    expect(current.type).toBe('span');
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual(['/']);
  });
});
