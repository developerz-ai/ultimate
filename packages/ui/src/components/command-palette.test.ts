// The wiring of the palette — what the markup carries and what a click or a key hands back —
// asked of the component; the rules have their own tests in `command-palette-view.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  byTag,
  fire,
  one,
  type ProbeNode,
  probe,
  renderNodes,
  unprobe,
  withAttr,
} from '../jsx-probe';
import { CommandPalette } from './CommandPalette';

const labels = {
  title: 'Command palette',
  filterLabel: 'Search commands',
  filterPlaceholder: 'Type a command…',
  emptyText: 'No matches',
  escHint: 'Esc',
};
const items = [
  { id: 'new', label: 'New link', hint: 'N' },
  { id: 'settings', label: 'Settings', hint: '' },
];
const noop = (): void => {};
const base = {
  labels,
  query: '',
  items,
  onQueryInput: noop,
  onFilterKeyDown: noop,
  onHoverItem: noop,
  onRunItem: noop,
  onClose: noop,
};

describe('CommandPalette', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('is a labelled dialog, closed on the server unless told otherwise', () => {
    const closed = one(byTag(renderNodes(CommandPalette, { ...base, open: false }), 'dialog'), 'd');
    expect(closed.props['aria-label']).toBe('Command palette');
    expect(closed.props['open']).toBeUndefined();
    const open = one(
      byTag(renderNodes(CommandPalette, { ...base, open: true, id: 'palette' }), 'dialog'),
      'd',
    );
    expect(open.props['open']).toBe(true);
    expect(open.props['id']).toBe('palette');
  });

  test('exactly one item is the tab stop — the active one — and each row is a native button', () => {
    const nodes = renderNodes(CommandPalette, { ...base, open: true, activeId: 'settings' });
    const buttons = byTag(nodes, 'button');
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.props['tabIndex'])).toEqual([-1, 0]);
    expect(withAttr(nodes, 'data-active', 'true')).toHaveLength(1);
  });

  test('a click runs the item and a hover moves the selection, by id', () => {
    const ran: string[] = [];
    const hovered: string[] = [];
    const nodes = renderNodes(CommandPalette, {
      ...base,
      open: true,
      onRunItem: (id: string) => ran.push(id),
      onHoverItem: (id: string) => hovered.push(id),
    });
    const [first] = byTag(nodes, 'button');
    fire(first as ProbeNode, 'onClick', {});
    fire(first as ProbeNode, 'onMouseEnter', {});
    expect(ran).toEqual(['new']);
    expect(hovered).toEqual(['new']);
  });

  test('no items renders the empty text instead of a list, and the Esc hint is a <kbd>', () => {
    const nodes = renderNodes(CommandPalette, { ...base, open: true, items: [] });
    expect(byTag(nodes, 'ul')).toHaveLength(0);
    expect(one(byTag(nodes, 'p'), 'empty').props['children']).toBe('No matches');
    expect(one(byTag(nodes, 'kbd'), 'esc').props['children']).toBe('Esc');
  });

  test('a cancel (Escape on a real dialog) closes through the caller, never by itself', () => {
    let closed = 0;
    const dialog = one(
      byTag(
        renderNodes(CommandPalette, { ...base, open: true, onClose: () => void closed++ }),
        'dialog',
      ),
      'd',
    );
    fire(dialog, 'onCancel', { preventDefault: noop });
    expect(closed).toBe(1);
  });
});
