// The palette's island half under a real Solid runtime: the `open` ATTRIBUTE is written and removed
// as the caller's flag moves, the filter takes focus on open, both refs reach the caller, typing
// reaches `onQueryInput`; and the two list shapes a server render can take — loading, grouped.

import '../theme/ambient';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  attachRef,
  byTag,
  fire,
  nodesOf,
  one,
  renderNodes,
  withAttr,
} from '@ultimat3/core/render-nodes';
import { browserSolid, runtimeOf, type Solid } from '../browser-fake-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { CommandPalette } from './CommandPalette';

const labels = {
  title: 'Command palette',
  filterLabel: 'Search commands',
  filterPlaceholder: 'Type a command…',
  emptyText: 'No matches',
  escHint: 'Esc',
};
const noop = (): void => {};
const base = {
  labels,
  query: '',
  items: [{ id: 'new', label: 'New link', hint: 'N' }],
  onQueryInput: noop,
  onFilterKeyDown: noop,
  onHoverItem: noop,
  onRunItem: noop,
  onClose: noop,
};

describe('CommandPalette under a real Solid runtime', () => {
  let solid: Solid;
  beforeAll(async () => {
    solid = await browserSolid();
  });
  afterEach(clearSolidRuntime);

  test('the open attribute follows the flag, focus goes to the filter, refs reach the caller', () => {
    setSolidRuntime(runtimeOf(solid));
    const [open, setOpen] = solid.createSignal(false);
    const attrs: string[] = [];
    const dialog = {
      setAttribute: (name: string) => attrs.push(`+${name}`),
      removeAttribute: (name: string) => attrs.push(`-${name}`),
    };
    let focused = 0;
    const filter = { focus: () => (focused += 1) };
    const refs: unknown[] = [];
    let dispose = noop;
    solid.createRoot((done) => {
      dispose = done;
      const output = CommandPalette({
        ...base,
        get open() {
          return open();
        },
        dialogRef: (el: unknown) => refs.push(['dialog', el]),
        filterRef: (el: unknown) => refs.push(['filter', el]),
      } as never);
      const nodes = nodesOf(output);
      attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), dialog);
      attachRef(one(byTag(nodes, 'input'), '<input>'), filter);
    });
    expect(refs).toEqual([
      ['dialog', dialog],
      ['filter', filter],
    ]);
    expect(attrs).toEqual(['-open']);
    setOpen(true);
    expect(attrs).toEqual(['-open', '+open']);
    expect(focused).toBe(1);
    setOpen(false);
    expect(attrs).toEqual(['-open', '+open', '-open']);
    expect(focused).toBe(1);
    dispose();
  });

  test('an open palette whose filter cannot focus still writes the attribute', () => {
    setSolidRuntime(runtimeOf(solid));
    const attrs: string[] = [];
    let dispose = noop;
    solid.createRoot((done) => {
      dispose = done;
      const nodes = nodesOf(CommandPalette({ ...base, open: true } as never));
      attachRef(one(byTag(nodes, 'dialog'), '<dialog>'), {
        setAttribute: (name: string) => attrs.push(`+${name}`),
        removeAttribute: noop,
      });
      attachRef(one(byTag(nodes, 'input'), '<input>'), {});
    });
    expect(attrs).toEqual(['+open']);
    dispose();
  });
});

describe('CommandPalette markup', () => {
  test('typing hands the field value to onQueryInput', () => {
    const typed: string[] = [];
    const nodes = renderNodes(CommandPalette, {
      ...base,
      open: true,
      onQueryInput: (value: string) => typed.push(value),
    });
    fire(one(byTag(nodes, 'input'), '<input>'), 'onInput', { currentTarget: { value: 'ne' } });
    expect(typed).toEqual(['ne']);
  });

  test('loading says so in a status in place of the list', () => {
    const nodes = renderNodes(CommandPalette, { ...base, open: true, loading: true });
    expect(byTag(nodes, 'ul')).toHaveLength(0);
    expect(withAttr(nodes, 'role', 'status')).toHaveLength(1);
  });

  test('grouped items render under one labelled group per run; the ungrouped run is a bare list', () => {
    const nodes = renderNodes(CommandPalette, {
      ...base,
      open: true,
      items: [
        { id: 'home', label: 'Home', hint: '' },
        { id: 'runs', label: 'Runs', hint: '', group: 'Pages' },
        { id: 'logs', label: 'Logs', hint: '', group: 'Pages' },
        { id: 'new', label: 'New', hint: '', group: 'Actions' },
      ],
    });
    const groups = withAttr(nodes, 'role', 'group');
    expect(groups).toHaveLength(2);
    const labelsById = new Map(
      byTag(nodes, 'p').map((p) => [p.props['id'], p.props['children']] as const),
    );
    expect(groups.map((g) => labelsById.get(g.props['aria-labelledby']))).toEqual([
      'Pages',
      'Actions',
    ]);
    expect(byTag(nodes, 'ul')).toHaveLength(3);
    expect(byTag(nodes, 'button')).toHaveLength(4);
  });
});
