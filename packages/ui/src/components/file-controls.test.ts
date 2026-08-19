// `file-input-view` already proves which files a control accepts. What it cannot see is whether
// the control ever ASKS it — a `<FileInput accept="image/png">` that hands `onSelect` every file
// the picker returned passes every test that helper has — and whether the progress bar it renders
// is a real determinate `progressbar` rather than a styled div.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UI_KEYS } from '../i18n-keys';
import { byTag, fire, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Combobox } from './Combobox';
import { Dropzone } from './Dropzone';
import { FileInput } from './FileInput';
import type { FileCandidate, FileSelection } from './file-input-view';

const PNG = { name: 'a.png', type: 'image/png', size: 10 };
const PDF = { name: 'b.pdf', type: 'application/pdf', size: 10 };
const HUGE = { name: 'c.png', type: 'image/png', size: 5_000 };

type Selection = FileSelection<FileCandidate>;

describe('the file controls', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('they compile to a JSX factory this file understands', () => {
    expect(renderNodes(FileInput, {}).length).toBeGreaterThan(0);
  });

  describe('FileInput', () => {
    test('keeps the platform control, dressed — never a div pretending to be one', () => {
      const input = one(byTag(renderNodes(FileInput, { name: 'avatar' }), 'input'), '<input>');
      expect(input.props['type']).toBe('file');
      expect(input.props['name']).toBe('avatar');
      expect(input.props['multiple']).toBe(false);
      expect(input.props['required']).toBe(false);
      expect(input.props['aria-invalid']).toBeUndefined();
    });

    test('partitions the picker’s files against its own limits before telling the caller', () => {
      const seen: Selection[] = [];
      const nodes = renderNodes(FileInput, {
        accept: 'image/png',
        maxBytes: 1_000,
        onSelect: (selection: Selection) => void seen.push(selection),
      });

      fire(one(byTag(nodes, 'input'), '<input>'), 'onChange', {
        currentTarget: { files: [PNG, PDF, HUGE] },
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.accepted).toEqual([PNG]);
      // Never dropped silently: a file that vanished with no reason reads as a broken control.
      expect(seen[0]?.rejected).toEqual([
        { file: PDF, reason: 'type' },
        { file: HUGE, reason: 'size' },
      ]);
    });

    test('a picker that returns nothing still reports an empty partition, not undefined', () => {
      const seen: Selection[] = [];
      const nodes = renderNodes(FileInput, {
        onSelect: (selection: Selection) => void seen.push(selection),
      });
      fire(one(byTag(nodes, 'input'), '<input>'), 'onChange', { currentTarget: { files: null } });
      expect(seen).toEqual([{ accepted: [], rejected: [] }]);
    });

    test('no progress prop renders no bar at all — never one stuck at zero', () => {
      expect(withAttr(renderNodes(FileInput, {}), 'role', 'progressbar')).toEqual([]);
    });

    test('a progress ratio becomes a determinate progressbar with a name from the catalog', () => {
      const bar = one(
        withAttr(renderNodes(FileInput, { progress: 0.42 }), 'role', 'progressbar'),
        'progressbar',
      );
      expect(bar.props['aria-valuemin']).toBe(0);
      expect(bar.props['aria-valuemax']).toBe(100);
      expect(bar.props['aria-valuenow']).toBe(42);
      expect(bar.props['aria-label']).toBe(`⟦${UI_KEYS.loading}⟧`);
      expect(bar.props['style']).toEqual({ '--file-progress': '42%' });
    });

    test('a ratio outside 0..1 is clamped rather than rendered as an impossible value', () => {
      const at = (progress: number): unknown =>
        one(withAttr(renderNodes(FileInput, { progress }), 'role', 'progressbar'), 'bar').props[
          'aria-valuenow'
        ];
      expect(at(-1)).toBe(0);
      expect(at(9)).toBe(100);
      expect(at(Number.NaN)).toBe(0);
    });

    test('an explicit progress label overrides the catalog default', () => {
      const bar = one(
        withAttr(
          renderNodes(FileInput, { progress: 0.5, progressLabel: 'Uploading avatar' }),
          'role',
          'progressbar',
        ),
        'progressbar',
      );
      expect(bar.props['aria-label']).toBe('Uploading avatar');
    });

    test('the wrapper carries the disabled state so the box can be styled', () => {
      expect(renderNodes(FileInput, {})[0]?.props['data-disabled']).toBeUndefined();
      expect(renderNodes(FileInput, { disabled: true })[0]?.props['data-disabled']).toBe('true');
    });
  });

  describe('Dropzone', () => {
    const zone = (extra: Record<string, unknown> = {}): ReturnType<typeof renderNodes> =>
      renderNodes(Dropzone, { label: 'Drop files', onSelect: (): void => undefined, ...extra });

    test('is a real label wrapping a real file input, wired by id', () => {
      const nodes = zone({ id: 'avatar-input' });
      expect(one(byTag(nodes, 'label'), '<label>').props['for']).toBe('avatar-input');
      expect(one(byTag(nodes, 'input'), '<input>').props['id']).toBe('avatar-input');
    });

    test('with no id it still wires the label to the input it rendered', () => {
      const nodes = zone();
      const id = one(byTag(nodes, 'input'), '<input>').props['id'];
      expect(typeof id).toBe('string');
      expect(one(byTag(nodes, 'label'), '<label>').props['for']).toBe(id);
    });

    test('the hint is a second line, and absent when not given', () => {
      expect(byTag(zone(), 'span').map((node) => node.props['children'])).toEqual(['Drop files']);
      expect(
        byTag(zone({ hint: 'PNG up to 1 MB' }), 'span').map((n) => n.props['children']),
      ).toEqual(['Drop files', 'PNG up to 1 MB']);
    });

    test('dragover is cancelled on every tick, or the browser navigates to the file', () => {
      const nodes = zone();
      const label = one(byTag(nodes, 'label'), '<label>');
      expect(label.props['data-over']).toBeUndefined();

      let prevented = 0;
      for (const handler of ['onDragEnter', 'onDragOver']) {
        fire(label, handler, { preventDefault: () => (prevented += 1) });
      }
      expect(prevented).toBe(2);
    });

    test('a disabled zone refuses the drag instead of cancelling the browser’s default', () => {
      const label = one(byTag(zone({ disabled: true }), 'label'), '<label>');
      let prevented = 0;
      fire(label, 'onDragOver', { preventDefault: () => (prevented += 1) });
      expect(prevented).toBe(0);
    });

    test('a drop partitions the files against the zone’s own limits', () => {
      const seen: Selection[] = [];
      const nodes = zone({
        accept: '.png',
        maxFiles: 1,
        onSelect: (selection: Selection) => void seen.push(selection),
      });
      const files = Object.assign([PNG, HUGE, PDF], { length: 3 });
      fire(one(byTag(nodes, 'label'), '<label>'), 'onDrop', {
        preventDefault: (): void => undefined,
        dataTransfer: { files },
      });

      expect(seen[0]?.accepted).toEqual([PNG]);
      expect(seen[0]?.rejected).toEqual([
        { file: HUGE, reason: 'count' },
        { file: PDF, reason: 'type' },
      ]);
    });

    test('a drop on a disabled zone reaches neither the input nor the caller', () => {
      const seen: Selection[] = [];
      const nodes = zone({
        disabled: true,
        onSelect: (selection: Selection) => void seen.push(selection),
      });
      const target = { files: null as unknown };
      (one(byTag(nodes, 'input'), '<input>').props['ref'] as (el: unknown) => void)(target);

      fire(one(byTag(nodes, 'label'), '<label>'), 'onDrop', {
        preventDefault: (): void => undefined,
        dataTransfer: { files: Object.assign([PNG], { length: 1 }) },
      });

      expect(seen).toEqual([]);
      expect(target.files).toBeNull();
    });

    test('the picker path partitions too, not only the drop path', () => {
      const seen: Selection[] = [];
      const nodes = zone({
        accept: '.png',
        onSelect: (selection: Selection) => void seen.push(selection),
      });
      fire(one(byTag(nodes, 'input'), '<input>'), 'onChange', {
        currentTarget: { files: [PDF] },
      });
      expect(seen[0]?.rejected).toEqual([{ file: PDF, reason: 'type' }]);
    });

    test('the progress bar is the same determinate control FileInput renders', () => {
      expect(withAttr(zone(), 'role', 'progressbar')).toEqual([]);
      const bar = one(withAttr(zone({ progress: 0.25 }), 'role', 'progressbar'), 'progressbar');
      expect(bar.props['aria-valuenow']).toBe(25);
      expect(bar.props['aria-label']).toBe(`⟦${UI_KEYS.loading}⟧`);
    });
  });

  describe('Combobox', () => {
    const options = [{ value: 'Paris' }, { value: 'Prague' }, { value: 'Berlin' }];

    test('picking a suggestion reports immediately, without waiting out the debounce', () => {
      const seen: string[] = [];
      const nodes = renderNodes(Combobox, {
        options,
        value: 'Pa',
        onFilter: (query: string) => void seen.push(query),
      });
      const input = one(byTag(nodes, 'input'), '<input>');

      // A keystroke goes through the timer, so nothing has been reported yet.
      fire(input, 'onInput', { currentTarget: { value: 'Par' } });
      expect(seen).toEqual([]);

      // Choosing from the list is a decision, not a keystroke.
      fire(input, 'onChange', { currentTarget: { value: 'Paris' } });
      expect(seen).toEqual(['Paris']);
    });

    test('the browser’s own history dropdown is turned off, or it covers the suggestions', () => {
      const nodes = renderNodes(Combobox, { options });
      const input = one(byTag(nodes, 'input'), '<input>');
      expect(input.props['autocomplete']).toBe('off');
      // The list the input names is the one this render actually produced.
      expect(input.props['list']).toBe(one(byTag(nodes, 'datalist'), 'datalist').props['id']);
    });

    test('the status region is always described-by the input, alongside the caller’s own', () => {
      const plain = one(byTag(renderNodes(Combobox, { options }), 'input'), '<input>');
      expect(String(plain.props['aria-describedby']).split(' ')).toHaveLength(1);

      const described = one(
        byTag(renderNodes(Combobox, { options, 'aria-describedby': 'hint-1' }), 'input'),
        '<input>',
      );
      const ids = String(described.props['aria-describedby']).split(' ');
      expect(ids[0]).toBe('hint-1');
      expect(ids).toHaveLength(2);
    });
  });
});
