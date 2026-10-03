// Where a relative `x shot --out` lands: under the directory the caller typed it from, the rule
// `x build --out` already follows. Against the app root it landed somewhere else whenever `x shot`
// ran from `apps/web` — two commands, one flag name, two meanings.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { shotOutDir } from './cmd-shot';

describe('unit · x shot --out resolves against the cwd', () => {
  test('a relative --out is the caller’s, an absolute one is itself, none is the default', () => {
    const root = '/work/app';
    const cwd = join(root, 'apps/web');
    expect(shotOutDir(cwd, 'shots', join(root, '.x/shots'))).toBe(join(cwd, 'shots'));
    expect(shotOutDir(cwd, '/tmp/shots', join(root, '.x/shots'))).toBe('/tmp/shots');
    expect(shotOutDir(cwd, undefined, join(root, '.x/shots'))).toBe(join(root, '.x/shots'));
  });
});
