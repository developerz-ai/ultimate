// The two key-path helpers no other test reached: `keyDirname` and `keyExtname`, which an app uses
// to group keys and to read a type off a key without a filesystem path module.

import { describe, expect, test } from 'bun:test';
import { keyDirname, keyExtname } from './path';

describe('keyDirname', () => {
  test('answers everything before the last segment', () => {
    expect(keyDirname('org/o1/a/b.png')).toBe('org/o1/a');
  });

  test('answers empty for a top-level key, never the key itself', () => {
    expect(keyDirname('b.png')).toBe('');
  });
});

describe('keyExtname', () => {
  test('answers the last dot of the basename, dot included', () => {
    expect(keyExtname('a/b.tar.gz')).toBe('.gz');
  });

  test('reads only the basename: a dot in a directory is no extension', () => {
    expect(keyExtname('org/o1.v2/readme')).toBe('');
  });

  test('a dotfile has no extension', () => {
    expect(keyExtname('org/o1/.env')).toBe('');
  });
});
