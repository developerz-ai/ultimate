// The fixture's one parse of a glob answer, against both separators a host can hand it.

import { describe, expect, test } from 'bun:test';
import { packageDirOf } from './island-fixture';

describe('packageDirOf', () => {
  test('a Windows glob answer names the package, not a cut-off path', () => {
    expect(packageDirOf('ui\\package.json')).toBe('ui');
  });

  test('a POSIX glob answer is read the same', () => {
    expect(packageDirOf('ui/package.json')).toBe('ui');
  });
});
