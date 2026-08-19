// The refusals first: a control that accepts everything it is shown is a control with no rule
// in it, and every assertion here is a file that must NOT reach the uploader.

import { describe, expect, test } from 'bun:test';
import {
  acceptMatches,
  adoptDroppedFiles,
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
// empty. `FileList` is a host type with no constructor, so the doubles below are structural — the
// only field this rule reads is `length`.
describe('adoptDroppedFiles', () => {
  const fileList = (length: number): FileList => ({ length }) as unknown as FileList;
  const target = (files: FileList | null = null): FileTarget => ({ files });

  test('a dropped file becomes the input’s own, so the form posts it', () => {
    const input = target();
    const dropped = fileList(1);
    adoptDroppedFiles(input, dropped);
    // Identity, not a copy: `files` takes the DataTransfer's own FileList, which is the supported
    // way to make a drop participate in the form.
    expect(input.files).toBe(dropped);
  });

  test('an empty drop leaves an earlier pick alone, exactly as the browser does', () => {
    const picked = fileList(2);
    const input = target(picked);
    adoptDroppedFiles(input, fileList(0));
    expect(input.files).toBe(picked);
  });

  test('no dataTransfer at all — undefined or null — clears nothing', () => {
    const picked = fileList(2);
    const undefinedDrop = target(picked);
    adoptDroppedFiles(undefinedDrop, undefined);
    expect(undefinedDrop.files).toBe(picked);

    const nullDrop = target(picked);
    adoptDroppedFiles(nullDrop, null);
    expect(nullDrop.files).toBe(picked);
  });

  test('an unmounted input is not an error: the ref is undefined before the effect runs', () => {
    expect(() => {
      adoptDroppedFiles(undefined, fileList(1));
    }).not.toThrow();
  });
});
