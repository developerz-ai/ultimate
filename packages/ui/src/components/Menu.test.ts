// `aria-controls` is an IDREF, and a closed Menu does not render its list — so a closed trigger
// that still named the list's id pointed assistive technology at an element not in the document.
// `Popover` already answers `undefined` while closed; this is the same rule for the same reason.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Menu } from './Menu';

type Control = Readonly<Record<string, unknown>>;

function render(open: boolean): { control: Control; menuIds: readonly unknown[] } {
  const seen: Control[] = [];
  const nodes = renderNodes(Menu, {
    items: [{ id: 'edit', label: 'Edit', onSelect: () => {} }],
    open,
    onOpenChange: () => {},
    trigger: (control: Control) => {
      seen.push(control);
      return 'open';
    },
    label: 'Actions',
  });
  expect(seen).toHaveLength(1);
  const menuIds = withAttr(nodes, 'role', 'menu').map((node) => node.props['id']);
  return { control: seen[0] as Control, menuIds };
}

describe('Menu trigger', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('a closed menu names no list it has not rendered', () => {
    const { control, menuIds } = render(false);
    expect(menuIds).toEqual([]);
    expect(control['aria-controls']).toBeUndefined();
    expect(control['aria-expanded']).toBe(false);
  });

  test('an open menu points its trigger at the list it rendered', () => {
    const { control, menuIds } = render(true);
    expect(menuIds).toHaveLength(1);
    expect(control['aria-controls']).toBe(menuIds[0]);
    expect(control['aria-expanded']).toBe(true);
  });
});
