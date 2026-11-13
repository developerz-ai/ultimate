// Which changelog entry declares a break, the diff the lock is judged by, and the lock `--write`
// writes: committed byte-for-byte the same on every OS.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './changelog-sections';
import { declaredBreak, diffApi, nextLock, parseLock, renderLock } from './public-api-breaks';

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

describe('public-api-breaks · the lock', () => {
  const lock = { version: '1.0.0', entries: { '@a/b': { x: '1', y: '2' } } };

  test('changed, removed and added are each found, sorted', () => {
    expect(diffApi(lock.entries, { '@a/b': { x: '9', z: '3' } })).toEqual({
      breaks: [
        { kind: 'changed', specifier: '@a/b', name: 'x' },
        { kind: 'removed', specifier: '@a/b', name: 'y' },
      ],
      added: [{ specifier: '@a/b', name: 'z' }],
    });
  });

  test('--write records additions and keeps an undeclared break as the lock held it', () => {
    const next = nextLock(lock, { '@a/b': { x: '9', z: '3' } }, '1.1.0', [
      { kind: 'removed', specifier: '@a/b', name: 'y' },
    ]);
    expect(next).toEqual({ version: '1.1.0', entries: { '@a/b': { x: '9', y: '2', z: '3' } } });
  });

  test('rendered with sorted keys, LF and a trailing newline, and parsed back', () => {
    const text = renderLock({ version: '1', entries: { b: { z: '1', a: '2' }, a: {} } });
    expect(text).toBe(
      '{\n  "version": "1",\n  "entries": {\n    "a": {},\n    "b": {\n      "a": "2",\n      "z": "1"\n    }\n  }\n}\n',
    );
    expect(parseLock(JSON.parse(text))).toEqual({
      version: '1',
      entries: { a: {}, b: { a: '2', z: '1' } },
    });
  });

  test('a lock of the wrong shape is a reason, never a cast', () => {
    expect(typeof parseLock({ version: 1, entries: {} })).toBe('string');
    expect(typeof parseLock({ version: '1', entries: { a: { b: 2 } } })).toBe('string');
  });
});
