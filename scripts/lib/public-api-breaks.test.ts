// Which changelog entry declares a break, the diff the lock is judged by — each change classified —
// and the lock `--write` writes from it.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './changelog-sections';
import { declaredBreak, diffApi, nextLock } from './public-api-breaks';
import type { ApiSymbol } from './public-api-compat';
import { symbolsOf } from './public-api-surface';

const changelog = (text: string) => [
  ...parseChangelog(text),
  ...parseChangelog('## 1.0.0 - 2026-11-13\n\n- **BREAKING —** (#1) `old` is gone.\n', 'x.md'),
];

describe('public-api-breaks · a declared break', () => {
  test('a BREAKING item under [Unreleased] naming the symbol, on its line or below it', () => {
    const log = changelog(
      '## [Unreleased]\n\n- **BREAKING —** (#1) the renderer\n  now takes `render(width: string)`.\n- other\n',
    );
    expect(declaredBreak(log, '2.0.0', 'render')).toBe(true);
  });

  test('a name only in a following, non-breaking item is not declared', () => {
    const log = changelog('## [Unreleased]\n\n- **BREAKING —** (#1) x\n- `render` got faster\n');
    expect(declaredBreak(log, '2.0.0', 'render')).toBe(false);
  });

  test('a `### BREAKING —` heading covers the items under it', () => {
    const log = changelog(
      '## [Unreleased]\n\n### BREAKING — (#2) renames\n\n- `render` → `paint`\n',
    );
    expect(declaredBreak(log, '2.0.0', 'render')).toBe(true);
  });

  test('a whole word only: `renderAll` does not declare `render`', () => {
    const log = changelog('## [Unreleased]\n\n- **BREAKING —** (#1) `renderAll` changed\n');
    expect(declaredBreak(log, '2.0.0', 'render')).toBe(false);
  });

  // A symbol name is matched as text: `$`, `.` and `\` mean themselves, never a pattern.
  test('a name is literal: every RegExp metacharacter in it, the backslash included', () => {
    const log = changelog('## [Unreleased]\n\n- **BREAKING —** (#1) `aXb` and `7` changed\n');
    expect(declaredBreak(log, '2.0.0', 'a.b')).toBe(false);
    expect(declaredBreak(log, '2.0.0', '\\d')).toBe(false);
    const named = changelog('## [Unreleased]\n\n- **BREAKING —** (#1) `$x`, `a.b`, `\\d`\n');
    for (const name of ['$x', 'a.b', '\\d']) expect(declaredBreak(named, '2.0.0', name)).toBe(true);
  });

  test("the current version's own section counts; an older one does not", () => {
    const log = changelog('## [Unreleased]\n\nNothing yet.\n');
    expect(declaredBreak(log, '1.0.0', 'old')).toBe(true);
    expect(declaredBreak(log, '1.0.1', 'old')).toBe(false);
  });
});

describe('public-api-breaks · the diff', () => {
  const one = (text: string): ApiSymbol =>
    symbolsOf({ x: text })['x'] ?? expect.unreachable('symbolsOf keeps every name');
  const x = {
    before: one('interface X { a : 1 ; }'),
    after: one('interface X { a : 1 ; b ? : 2 ; }'),
  };
  const w = {
    before: one('interface W { a : 1 ; }'),
    after: one('interface W { a : 1 ; b : 2 ; }'),
  };
  const [y, z] = [one('const y : 2'), one('const z : 3')];
  const lock = { '@a/b': { x: x.before, y, w: w.before } };
  const tree = { '@a/b': { x: x.after, w: w.after, z } };

  test('compatible, breaking, removed and added are each found, sorted, with why', () => {
    expect(diffApi(lock, tree)).toEqual({
      breaks: [
        { kind: 'changed', specifier: '@a/b', name: 'w', why: 'required member `b` was added' },
        { kind: 'removed', specifier: '@a/b', name: 'y', why: 'it is no longer exported' },
      ],
      compatible: [{ specifier: '@a/b', name: 'x', why: 'optional `b` added' }],
      added: [{ specifier: '@a/b', name: 'z' }],
    });
  });

  test('--write records compatible changes and keeps an undeclared break as the lock held it', () => {
    const { breaks } = diffApi(lock, tree);
    const next = nextLock(lock, tree, '1.1.0', breaks);
    expect(next.format).toBe(2);
    expect(next.version).toBe('1.1.0');
    expect(next.entries['@a/b']).toEqual({ x: x.after, w: w.before, y, z });
  });
});
