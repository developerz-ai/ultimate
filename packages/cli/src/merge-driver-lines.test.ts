// Which conflicts `x merge-driver` may resolve: both sides adding whole entries, and nothing else.

import { describe, expect, test } from 'bun:test';
import { resolveAdditions } from './merge-driver-lines';

const conflict = (ours: string[], base: string[], theirs: string[]): string[] => [
  '<<<<<<< ours',
  ...ours,
  '||||||| base',
  ...base,
  '=======',
  ...theirs,
  '>>>>>>> theirs',
];

const merged = (ours: string[], theirs: string[], base: string[] = []) =>
  resolveAdditions(['before', ...conflict(ours, base, theirs), 'after', ''].join('\n'));

describe('unit · both sides added', () => {
  test('list entries are all kept, in one order whichever side is ours', () => {
    const one = merged(['  beta,'], ['  alpha,']);
    const other = merged(['  alpha,'], ['  beta,']);
    expect(one).toEqual({ text: 'before\n  alpha,\n  beta,\nafter\n', conflicts: 0 });
    expect(other).toEqual(one);
  });

  test('imports land sorted by module, as the formatter requires', () => {
    const { text } = merged(
      ["import * as z from '../app/beta/z';"],
      ["import * as a from '../app/alpha/a';"],
    );
    expect(text.split('\n').slice(1, 3)).toEqual([
      "import * as a from '../app/alpha/a';",
      "import * as z from '../app/beta/z';",
    ]);
  });

  test('multi-line entries stay whole: their shared closing lines are not spliced', () => {
    const entry = (name: string): string[] => [`  ${name}: {`, "    off: 'why',", '  },'];
    const { text, conflicts } = merged(entry('zeta'), entry('alpha'));
    expect(conflicts).toBe(0);
    expect(text.split('\n').slice(1, 7)).toEqual([...entry('alpha'), ...entry('zeta')]);
  });

  test('an entry both sides added identically appears once', () => {
    const line = "import { userActor } from '@ultimat3/core';";
    expect(merged([line], [line]).text).toBe(`before\n${line}\nafter\n`);
  });

  test('a comment travels with the entry below it', () => {
    const { text, conflicts } = merged(['  // why', '  zeta,'], ['  alpha,']);
    expect(conflicts).toBe(0);
    expect(text).toBe('before\n  // why\n  zeta,\n  alpha,\nafter\n');
  });
});

describe('unit · a real conflict stays one, markers and all', () => {
  const stays = (result: ReturnType<typeof merged>): void => {
    expect(result.conflicts).toBe(1);
    expect(result.text).toContain('<<<<<<< ours');
    expect(result.text).toContain('>>>>>>> theirs');
  };

  test('a line that existed before was changed: a revoked grant is not resurrected', () => {
    stays(merged(["  'a:read',"], ["  'a:write',", "  'b:read',"], ["  'a:write',"]));
  });

  test('one key, two values', () => {
    stays(merged(['  createPost: { off: 1 },'], ['  createPost: { off: 2 },']));
  });

  test('one import binding from two modules', () => {
    stays(merged(["import * as list from './a';"], ["import * as list from './b';"]));
  });

  test('two imports from one module, which only a person can combine', () => {
    stays(merged(["import { a } from 'm';"], ["import { b } from 'm';"]));
  });

  test('an addition that is not a whole entry', () => {
    stays(merged(['  a: {'], ['  b,']));
    stays(merged(['  no-trailing-comma'], ['  b,']));
  });

  test('text with no conflict passes through byte for byte', () => {
    expect(resolveAdditions('a\nb\n')).toEqual({ text: 'a\nb\n', conflicts: 0 });
  });
});
