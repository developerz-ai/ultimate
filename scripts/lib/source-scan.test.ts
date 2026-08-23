// The enforcement half of `scripts/lib/source-scan.ts`: this file pins the semantics the five
// diverged copies (#282) could not agree on, and proves no copy is left behind.

import { describe, expect, test } from 'bun:test';
import { isCode, isDeclaration, isTestPath, lineOf } from './source-scan';

describe('isTestPath', () => {
  test('a declaration file is shipped source, not a test — the divergence #282 measured', () => {
    expect(isTestPath('packages/ui/src/scss.d.ts')).toBe(false);
    expect(isTestPath('packages/ui/src/x.d.tsx')).toBe(false);
  });

  test('test and spec, both extensions', () => {
    for (const path of ['a.test.ts', 'a.test.tsx', 'a.spec.ts', 'a.spec.tsx']) {
      expect(isTestPath(path)).toBe(true);
    }
  });

  test('a file merely NAMED after a test is source', () => {
    expect(isTestPath('packages/testing/src/test-setup.ts')).toBe(false);
    expect(isTestPath('packages/cli/src/verify-test-run.ts')).toBe(false);
  });
});

describe('isDeclaration', () => {
  test('answers the question isTestPath used to be asked by proxy', () => {
    expect(isDeclaration('packages/ui/src/scss.d.ts')).toBe(true);
    expect(isDeclaration('packages/ui/src/scss.ts')).toBe(false);
    expect(isDeclaration('a.test.ts')).toBe(false);
  });
});

describe('lineOf', () => {
  test('is 1-based and counts newlines before the index', () => {
    const text = 'a\nb\nc';
    expect(lineOf(text, 0)).toBe(1);
    expect(lineOf(text, 2)).toBe(2);
    expect(lineOf(text, 4)).toBe(3);
  });

  test('agrees with the slice/split form it replaced, at every index', () => {
    const text = 'one\ntwo\n\nthree\r\nfour';
    for (let index = 0; index <= text.length; index += 1) {
      expect(lineOf(text, index)).toBe(text.slice(0, index).split('\n').length);
    }
  });

  test('an index past the end is the last line, never a crash', () => {
    expect(lineOf('a\nb', 999)).toBe(2);
  });
});

describe('isCode', () => {
  test('a declaration whose keyword survived the mask is code', () => {
    expect(isCode('const X = 1;', 0, 'const X')).toBe(true);
  });

  test('a declaration blanked by the mask is inside a string literal', () => {
    expect(isCode('            ', 0, 'const X')).toBe(false);
  });

  test('leading whitespace in the matched text is skipped before the mask is read', () => {
    expect(isCode('  const X = 1;', 0, '  const X')).toBe(true);
    expect(isCode('              ', 0, '  const X')).toBe(false);
  });
});
