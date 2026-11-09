// When a double is put back: a test's after that test, last made first undone, every undo run even
// past a throw; one made outside a test after its file. The preload installs the hooks here.

import { describe, expect, test } from 'bun:test';
import { TestScopeUninstalledError } from './stub-errors';
import { deferRestore, endFileScope, endTestScope, inTestScope } from './test-scope';

const undone: string[] = [];
// Module scope: no test is running, so this is the FILE's, and survives every test below.
deferRestore('file double', () => undone.push('file'));

describe('test scope', () => {
  test('a test body is in the test scope, and the file double is still live', () => {
    expect(inTestScope()).toBe(true);
    expect(undone).toEqual([]);
  });

  test("a test's doubles unwind last-first, and every one runs past a throw", () => {
    deferRestore('first', () => undone.push('first'));
    deferRestore('second', () => {
      undone.push('second');
      throw new TestScopeUninstalledError('second');
    });
    deferRestore('third', () => undone.push('third'));
    expect(() => endTestScope()).toThrow('second');
    expect(undone).toEqual(['third', 'second', 'first']);
    expect(inTestScope()).toBe(false);
  });

  test('the file boundary undoes what was made outside every test', () => {
    undone.length = 0;
    endFileScope();
    expect(undone).toEqual(['file']);
  });

  test('a double with nobody to put it back is refused by code', () => {
    expect(new TestScopeUninstalledError('stub(x)')).toBeUltimateError('X_TEST_SCOPE_UNINSTALLED');
  });
});
