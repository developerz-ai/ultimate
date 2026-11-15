// The diff a skipped file is reported with: unified, `---`/`+++` named by the path, three lines of
// context, and nothing at all for two equal texts.

import { describe, expect, test } from 'bun:test';
import { unifiedDiff } from './engine-diff';

const lines = (count: number, from = 1): string =>
  Array.from({ length: count }, (_, i) => `line ${String(i + from)}`).join('\n');

describe('unit · codemod engine, unifiedDiff', () => {
  test('equal texts are no diff', () => {
    expect(unifiedDiff('a.ts', 'x\ny\n', 'x\ny\n')).toBe('');
  });

  test('one changed line is one hunk with three lines of context each side', () => {
    const before = `${lines(10)}\n`;
    const after = before.replace('line 5\n', 'line five\n');
    expect(unifiedDiff('src/a.ts', before, after)).toBe(
      [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -2,7 +2,7 @@',
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '+line five',
        ' line 6',
        ' line 7',
        ' line 8',
        '',
      ].join('\n'),
    );
  });

  test('two changes far apart are two hunks; an insertion keeps the lines around it as context', () => {
    const before = `${lines(30)}\n`;
    const after = before.replace('line 2\n', 'line 2\nnew\n').replace('line 28\n', '');
    const diff = unifiedDiff('a.ts', before, after);
    expect(diff.match(/^@@/gm)?.length).toBe(2);
    expect(diff).toContain('@@ -1,5 +1,6 @@');
    expect(diff).toContain('+new');
    expect(diff).toContain('@@ -25,6 +26,5 @@');
    expect(diff).toContain('-line 28');
  });

  test('a new file is all additions against /dev/null', () => {
    expect(unifiedDiff('a.ts', undefined, 'x\n')).toBe(
      ['--- /dev/null', '+++ b/a.ts', '@@ -0,0 +1,1 @@', '+x', ''].join('\n'),
    );
  });
});
