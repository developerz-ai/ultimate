// The lock file: format 2 one line per symbol, sorted, LF on every OS and parsed back; format 1
// (hashes only) still read, with no shapes; anything else a reason, never a cast.

import { describe, expect, test } from 'bun:test';
import type { ApiSymbol } from './public-api-compat';
import type { ApiLock } from './public-api-lock';
import { parseLock, renderLock } from './public-api-lock';

const SHAPED = {
  hash: 'h2',
  shape: { kind: 'members', head: 'aa', members: { z: '?1', a: '2' } },
} as const;

describe('public-api-lock', () => {
  test('rendered with sorted keys, one line per symbol, LF and a trailing newline', () => {
    const text = renderLock({
      format: 2,
      version: '1',
      entries: { b: { z: { hash: 'h1' }, a: SHAPED }, a: {} },
    });
    expect(text).toBe(
      [
        '{',
        '  "format": 2,',
        '  "version": "1",',
        '  "entries": {',
        '    "a": {},',
        '    "b": {',
        '      "a": {"hash":"h2","shape":{"kind":"members","head":"aa","members":{"a":"2","z":"?1"}}},',
        '      "z": {"hash":"h1"}',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(parseLock(JSON.parse(text))).toEqual({
      format: 2,
      version: '1',
      entries: { a: {}, b: { a: SHAPED, z: { hash: 'h1' } } },
    });
  });

  test('a function shape survives the round trip', () => {
    const fn: ApiSymbol = {
      hash: 'h',
      shape: { kind: 'function', head: 'a', params: ['?b'], returns: 'c' },
    };
    const lock: ApiLock = { format: 2, version: '1', entries: { a: { f: fn } } };
    expect(parseLock(JSON.parse(renderLock(lock)))).toEqual(lock);
  });

  test('a format-1 lock (no format field, bare hashes) parses with no shapes', () => {
    expect(parseLock({ version: '1', entries: { a: { b: 'h' } } })).toEqual({
      format: 1,
      version: '1',
      entries: { a: { b: { hash: 'h' } } },
    });
  });

  test('a lock of the wrong shape or an unknown format is a reason, never a cast', () => {
    expect(typeof parseLock({ version: 1, entries: {} })).toBe('string');
    expect(typeof parseLock({ version: '1', entries: { a: { b: 2 } } })).toBe('string');
    expect(typeof parseLock({ format: 2, version: '1', entries: { a: { b: 'h' } } })).toBe(
      'string',
    );
    expect(parseLock({ format: 3, version: '1', entries: {} })).toContain('`format` 3');
    const badShape = { hash: 'h', shape: { kind: 'members', head: 'a', members: { x: 1 } } };
    expect(typeof parseLock({ format: 2, version: '1', entries: { a: { b: badShape } } })).toBe(
      'string',
    );
  });
});
