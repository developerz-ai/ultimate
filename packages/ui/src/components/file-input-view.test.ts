// The refusals first: a control that accepts everything it is shown is a control with no rule
// in it, and every assertion here is a file that must NOT reach the uploader.

import { describe, expect, test } from 'bun:test';
import {
  acceptMatches,
  adoptAcceptedFiles,
  type FileCandidate,
  type FileTarget,
  formatBytes,
  progressPercent,
  selectFiles,
} from './file-input-view';

const file = (name: string, type: string, size = 10): FileCandidate => ({ name, type, size });

describe('acceptMatches', () => {
  test('matches a wildcard family, an exact type and an extension', () => {
    expect(acceptMatches('image/*', file('a.png', 'image/png'))).toBe(true);
    expect(acceptMatches('image/png,image/jpeg', file('a.jpg', 'image/jpeg'))).toBe(true);
    expect(acceptMatches('.pdf', file('report.PDF', 'application/pdf'))).toBe(true);
    expect(acceptMatches('IMAGE/PNG', file('a.png', 'image/png'))).toBe(true);
  });

  test('turns away a type outside the list', () => {
    expect(acceptMatches('image/*', file('a.pdf', 'application/pdf'))).toBe(false);
    expect(acceptMatches('.png', file('a.pdf', 'application/pdf'))).toBe(false);
  });

  // The one that decides whether the rule fails open or closed.
  test('a file the browser could not type matches no MIME pattern', () => {
    expect(acceptMatches('image/*', file('mystery', ''))).toBe(false);
    expect(acceptMatches('*/*', file('mystery', ''))).toBe(false);
    // An extension pattern still matches: it reads the name, which is present either way.
    expect(acceptMatches('.png', file('mystery.png', ''))).toBe(true);
  });

  test('an empty accept accepts everything, which is what an absent attribute means', () => {
    expect(acceptMatches('', file('a.exe', 'application/x-msdownload'))).toBe(true);
  });
});

describe('selectFiles', () => {
  test('reports every refusal with the reason that caused it', () => {
    const selection = selectFiles(
      [
        file('ok.png', 'image/png', 100),
        file('big.png', 'image/png', 5000),
        file('doc.pdf', 'application/pdf', 10),
        file('second.png', 'image/png', 100),
      ],
      { accept: 'image/*', maxBytes: 1000, maxFiles: 1 },
    );
    expect(selection.accepted.map((one) => one.name)).toEqual(['ok.png']);
    expect(selection.rejected).toEqual([
      { file: file('big.png', 'image/png', 5000), reason: 'size' },
      { file: file('doc.pdf', 'application/pdf', 10), reason: 'type' },
      { file: file('second.png', 'image/png', 100), reason: 'count' },
    ]);
  });

  test('no limits accepts the lot', () => {
    const selection = selectFiles([file('a.exe', '', 1)]);
    expect(selection.accepted.length).toBe(1);
    expect(selection.rejected).toEqual([]);
  });
});

describe('progressPercent', () => {
  test('clamps, rounds, and never produces NaN', () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(0.456)).toBe(46);
    expect(progressPercent(1)).toBe(100);
    expect(progressPercent(4)).toBe(100);
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(Number.NaN)).toBe(0);
    expect(progressPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('formatBytes', () => {
  test('steps through decimal units, because that is what Intl’s byte units mean', () => {
    expect(formatBytes(0, 'en-US')).toBe('0 byte');
    expect(formatBytes(999, 'en-US')).toBe('999 byte');
    expect(formatBytes(1000, 'en-US')).toBe('1 kB');
    expect(formatBytes(1_500_000, 'en-US')).toBe('1.5 MB');
  });

  test('formats in the caller’s locale', () => {
    expect(formatBytes(1_500_000, 'de-DE')).toBe('1,5 MB');
  });

  test('a negative or non-finite size is 0, never a bar that renders NaN', () => {
    expect(formatBytes(-1, 'en-US')).toBe('0 byte');
    expect(formatBytes(Number.NaN, 'en-US')).toBe('0 byte');
  });
});

// The half a component test could never reach: a `<Dropzone name="avatar" required>` showed the
// file it accepted and then refused to submit, because `onSelect` fired and `input.files` stayed
// empty — and once it did adopt the drop, it adopted the REFUSED files too, so a file `accept` or
// `maxBytes` turned away was posted anyway. `FileList` is a host type with no constructor, so the
// list factory is injected and the doubles are structural.
describe('adoptAcceptedFiles', () => {
  const listed: (readonly FileCandidate[])[] = [];
  const listOf = (files: readonly FileCandidate[]): FileList => {
    listed.push(files);
    return { length: files.length, files } as unknown as FileList;
  };
  const target = (files: FileList | null = null): FileTarget => ({ files });
  const picked = { length: 2 } as unknown as FileList;
  const png = file('a.png', 'image/png');
  const exe = file('b.exe', 'application/x-msdownload');
  const limits = { accept: 'image/*' };

  test('a drop hands the input exactly the accepted files — a refused one is never posted', () => {
    const input = target();
    adoptAcceptedFiles(input, null, selectFiles([png, exe], limits), 'drop', listOf);
    expect(listed.at(-1)).toEqual([png]);
    expect(input.files?.length).toBe(1);
  });

  test('a drop with nothing accepted leaves an earlier pick alone, as a refused drop should', () => {
    const input = target(picked);
    adoptAcceptedFiles(input, null, selectFiles([exe], limits), 'drop', listOf);
    adoptAcceptedFiles(input, null, selectFiles([], limits), 'drop', listOf);
    expect(input.files).toBe(picked);
  });

  test('a pick that refused a file is narrowed to what was accepted — to nothing, if need be', () => {
    const input = target(picked);
    adoptAcceptedFiles(input, picked, selectFiles([png, exe], limits), 'pick', listOf);
    expect(listed.at(-1)).toEqual([png]);
    adoptAcceptedFiles(input, picked, selectFiles([exe], limits), 'pick', listOf);
    expect(input.files?.length).toBe(0);
  });

  test('a drop that refused nothing hands over its own list, untouched', () => {
    const input = target();
    const dropped = { length: 1 } as unknown as FileList;
    const before = listed.length;
    adoptAcceptedFiles(input, dropped, selectFiles([png], limits), 'drop', listOf);
    expect(input.files).toBe(dropped);
    expect(listed.length).toBe(before);
  });

  test('a pick that refused nothing is left exactly as the browser set it', () => {
    const input = target(picked);
    adoptAcceptedFiles(input, picked, selectFiles([png], limits), 'pick', listOf);
    expect(input.files).toBe(picked);
  });

  test('an unmounted input is not an error: the ref is undefined before the effect runs', () => {
    expect(() => {
      adoptAcceptedFiles(undefined, null, selectFiles([png], limits), 'drop', listOf);
    }).not.toThrow();
  });
});
