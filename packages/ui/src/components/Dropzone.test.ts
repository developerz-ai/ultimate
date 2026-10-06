// `multiple` is a limit on a DROP too. The picker honours the attribute by itself, but a drop
// bypasses the picker entirely, so a single-file zone handed every dropped file to `onSelect` and
// to the input — and the form posted three avatars for one slot.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachRef, byTag, fire, one, probe, renderNodes, unprobe } from '../jsx-probe';
import { Dropzone } from './Dropzone';
import type { FileCandidate, FileSelection } from './file-input-view';

/** A browser narrows the input's list with `DataTransfer`; Bun has none, so the double records it. */
class FakeTransfer {
  readonly added: unknown[] = [];
  readonly items = { add: (file: unknown): number => this.added.push(file) };
  get files(): unknown {
    return Object.assign([...this.added], { length: this.added.length });
  }
}

const png = (name: string) => ({ name, type: 'image/png', size: 10 });

function drop(
  props: Record<string, unknown>,
  files: readonly FileCandidate[],
): FileSelection<FileCandidate> {
  const selections: FileSelection<FileCandidate>[] = [];
  const nodes = renderNodes(Dropzone, {
    label: 'Drop files',
    name: 'avatar',
    ...props,
    onSelect: (selection: FileSelection<FileCandidate>) => selections.push(selection),
  });
  attachRef(one(byTag(nodes, 'input'), '<input>'), { files: null });
  fire(one(byTag(nodes, 'label'), '<label>'), 'onDrop', {
    preventDefault: () => {},
    dataTransfer: { files: Object.assign([...files], { length: files.length }) },
  });
  expect(selections).toHaveLength(1);
  return selections[0] as FileSelection<FileCandidate>;
}

describe('Dropzone multiple', () => {
  const had = 'DataTransfer' in globalThis;
  beforeAll(() => {
    probe();
    if (!had) Object.assign(globalThis, { DataTransfer: FakeTransfer });
  });
  afterAll(() => {
    if (!had) Reflect.deleteProperty(globalThis, 'DataTransfer');
    unprobe();
  });

  test('a zone without `multiple` accepts one dropped file and refuses the rest by count', () => {
    const [a, b, c] = [png('a.png'), png('b.png'), png('c.png')];
    const selection = drop({}, [a, b, c]);
    expect(selection.accepted).toEqual([a]);
    expect(selection.rejected).toEqual([
      { file: b, reason: 'count' },
      { file: c, reason: 'count' },
    ]);
  });

  test('`multiple` keeps every dropped file, up to `maxFiles` when one is set', () => {
    const files = [png('a.png'), png('b.png'), png('c.png')];
    expect(drop({ multiple: true }, files).accepted).toEqual(files);
    expect(drop({ multiple: true, maxFiles: 2 }, files).accepted).toEqual(files.slice(0, 2));
  });

  test('a `maxFiles` above one cannot widen a single-file zone', () => {
    const files = [png('a.png'), png('b.png')];
    expect(drop({ maxFiles: 5 }, files).accepted).toEqual(files.slice(0, 1));
  });
});
