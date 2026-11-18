// `actions-cache-prune.ts`: which cache entries a newer one supersedes, and which it never touches.

import { describe, expect, test } from 'bun:test';
import type { CacheEntry } from './actions-cache-prune';
import { entryOf, supersededEntries } from './actions-cache-prune';

let next = 0;
const entry = (key: string, createdAt: string, ref = 'refs/heads/main'): CacheEntry => {
  next += 1;
  return { id: next, ref, key, sizeInBytes: 1, createdAt };
};
const keys = (entries: readonly CacheEntry[]): string[] => entries.map((e) => e.key).sort();

describe('unit · a superseded cache entry is pruned, a live one never', () => {
  test('only the newest CodeQL overlay base per ref and language stays', () => {
    const base = 'codeql-overlay-base-database-1-c801913f1ee29663-javascript-2.27.4-';
    const older = `${base}4ed847b5a6b18291c52d310247e7959d0b0d59a7-44247094773-1`;
    const oldest = `${base}b69f8ed913434bd4cb1cd9e8c190f86b43d7f02f-44246243231-1`;
    const dead = supersededEntries([
      entry(`${base}084da633e8372fd825f5a062c0883e576c5217d5-44261531405-1`, '2026-11-18T08:01:32Z'),
      entry(older, '2026-11-18T06:08:19Z'),
      entry(oldest, '2026-11-18T06:02:09Z'),
      // Another language, and another query configuration: each its own newest.
      entry(`${base.replace('javascript', 'actions')}${'a'.repeat(40)}-1-1`, '2026-11-18T01:00:00Z'),
      entry(`${base.replace('c801913f1ee29663', '0123456789abcdef')}${'b'.repeat(40)}-1-1`, '2026-11-18T01:00:00Z'),
    ]);
    expect(keys(dead)).toEqual([older, oldest]);
  });

  test('an older lockfile install cache is dead, per OS and per ref', () => {
    const dead = supersededEntries([
      entry(`bun-Linux-${'8'.repeat(64)}`, '2026-11-18T00:08:33Z'),
      entry(`bun-Linux-${'6'.repeat(64)}`, '2026-11-16T22:29:32Z'),
      entry(`bun-macOS-${'6'.repeat(64)}`, '2026-11-16T22:51:33Z'),
      entry(`bun-Linux-${'6'.repeat(64)}`, '2026-11-16T22:00:00Z', 'refs/pull/1229/merge'),
    ]);
    expect(keys(dead)).toEqual([`bun-Linux-${'6'.repeat(64)}`]);
    expect(dead[0]?.ref).toBe('refs/heads/main');
  });

  test('content-addressed and unknown keys are never pruned, however many there are', () => {
    expect(
      supersededEntries([
        entry('buildkit-blob-1-sha256:c7fc3c15bb8d72cd599c70751a0122653d', '2026-11-18T00:00:00Z'),
        entry('buildkit-blob-1-sha256:d96cd1276e66e6978c9bdce199c79ca80f', '2026-11-17T00:00:00Z'),
        entry('islands-examples/dummy-0123456789abcdef', '2026-11-18T00:00:00Z'),
        entry('islands-examples/dummy-fedcba9876543210', '2026-11-17T00:00:00Z'),
      ]),
    ).toEqual([]);
  });
});

describe('unit · a gh cache object is read, or refused', () => {
  test('the five fields it needs, renamed', () => {
    expect(
      entryOf({ id: 3, ref: 'r', key: 'k', size_in_bytes: 9, created_at: 't', version: 'x' }),
    ).toEqual({ id: 3, ref: 'r', key: 'k', sizeInBytes: 9, createdAt: 't' });
  });

  test('a missing or mistyped field is no entry', () => {
    expect(entryOf({ id: '3', ref: 'r', key: 'k', size_in_bytes: 9, created_at: 't' })).toBe(
      undefined,
    );
    expect(entryOf({ id: 3, ref: 'r', key: 'k', created_at: 't' })).toBe(undefined);
    expect(entryOf(null)).toBe(undefined);
  });
});
