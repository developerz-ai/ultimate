// Which conflicts `x merge-driver` may resolve: both sides adding whole entries, and nothing else.

import { describe, expect, test } from 'bun:test';
import { conflictsLeft, markerAt, resolveAdditions } from './merge-driver-lines';

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

// `git merge-file` ends its markers the way the file ends its lines: on a CRLF checkout each is
// `<<<<<<< ours\r`. Compared whole, none was a marker — the text passed through with every marker
// in it, reported as 0 conflicts, and the driver exited 0: git recorded a clean merge.
describe('unit · a CRLF file', () => {
  const crlf = (lines: string[]): string => lines.map((line) => `${line}\r\n`).join('');

  test("CRLF input: both sides' additions merge, and an unrecognised marker is never reported as 0 conflicts", () => {
    const text = crlf(['before', ...conflict(['  beta,'], [], ['  alpha,']), 'after']);
    // Merged, and every line still ends as the file's lines do.
    expect(resolveAdditions(text)).toEqual({
      text: 'before\r\n  alpha,\r\n  beta,\r\nafter\r\n',
      conflicts: 0,
    });

    // A real conflict stays one, counted, with its markers as git wrote them.
    const real = resolveAdditions(
      crlf(['before', ...conflict(['  a: 1,'], [], ['  a: 2,']), 'after']),
    );
    expect(real.conflicts).toBe(1);
    expect(real.text).toContain('<<<<<<< ours\r\n');

    // The backstop: git said it left conflicts and the text still opens one, whatever the
    // resolver counted — a marker spelling it does not know must not become exit 0.
    const unknown = 'a\n<<<<<<< ours\u2028\nb\n';
    expect(resolveAdditions(unknown).conflicts).toBe(0);
    expect(conflictsLeft(unknown, 0, 2)).toBe(2);
    // Nothing invented where there is nothing left, or where git reported none.
    expect(conflictsLeft('a\nb\n', 0, 1)).toBe(0);
    expect(conflictsLeft(unknown, 0, 0)).toBe(0);
    expect(conflictsLeft(real.text, 1, 3)).toBe(1);
  });
});

// Each hunk looks for its three markers from where it stands: a scan from line zero per lookup made
// a file of many hunks quadratic. The lines before `from` are never read.
describe('unit · markerAt', () => {
  test('reads from `from` on and stops at the first marker', () => {
    const lines = ['a', '=======', 'b', 'c', '=======', 'd', '=======\r', 'e'];
    const read: number[] = [];
    const watched = new Proxy(lines, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) read.push(Number(key));
        return Reflect.get(target, key, receiver);
      },
    });
    expect(markerAt(watched, '=======', 2)).toBe(4);
    expect(read).toEqual([2, 3, 4]);
    expect(markerAt(lines, '=======', 5)).toBe(6);
    expect(markerAt(lines, '=======', 7)).toBe(-1);
    expect(markerAt(lines, '=======', -1)).toBe(-1);
  });
});
