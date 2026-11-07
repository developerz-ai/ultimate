// `Tabs` in both modes, through the node tree: link mode is a `<nav>` of links with exactly one
// `aria-current` and no ARIA tab roles; button mode keeps its tablist untouched.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import { byTag, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { UI_ERROR_CODES } from '../errors';
import { Tabs } from './Tabs';

const items = [
  { id: 'profile', label: 'Profile' },
  { id: 'billing', label: 'Billing' },
  { id: 'danger', label: 'Danger zone' },
];

describe('Tabs, link mode', () => {
  test('a <nav> of links, no role="tab", exactly one aria-current on the current one', () => {
    const nodes = renderNodes(Tabs, {
      items,
      value: 'billing',
      hrefFor: (id: string) => `/settings/${id}`,
      label: 'Settings',
      children: 'body',
    });
    expect(byTag(nodes, 'nav')).toHaveLength(1);
    expect(withAttr(nodes, 'role', 'tab')).toHaveLength(0);
    expect(withAttr(nodes, 'role', 'tabpanel')).toHaveLength(0);
    const links = byTag(nodes, 'a');
    expect(links.map((a) => a.props['href'])).toEqual([
      '/settings/profile',
      '/settings/billing',
      '/settings/danger',
    ]);
    expect(withAttr(nodes, 'aria-current', 'page').map((a) => a.props['href'])).toEqual([
      '/settings/billing',
    ]);
  });

  test('a non-string href is X_UI_INVALID_VALUE', () => {
    try {
      renderNodes(Tabs, { items, value: 'billing', hrefFor: () => 7, label: 'Settings' });
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe(UI_ERROR_CODES.invalidValue);
      return;
    }
    expect.unreachable('a numeric href rendered');
  });
});

describe('Tabs, button mode', () => {
  test('still a tablist with tabs and panels, and no link', () => {
    const nodes = renderNodes(Tabs, {
      items: items.map((item) => ({ ...item, panel: item.label })),
      value: 'billing',
      onChange: () => {},
      label: 'Settings',
    });
    expect(withAttr(nodes, 'role', 'tablist')).toHaveLength(1);
    expect(withAttr(nodes, 'role', 'tab')).toHaveLength(3);
    expect(byTag(nodes, 'a')).toHaveLength(0);
    expect(withAttr(nodes, 'aria-current', 'page')).toHaveLength(0);
  });
});
