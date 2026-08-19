// The rewrite, driven over a lockfile fragment rather than the committed file: the negative case
// has to be a fixture, or the only way to see this rule fail is to break the repo's own install.

import { describe, expect, test } from 'bun:test';
import { correctLockfile } from './lockfile-pins';

/** Two workspace blocks in `bun.lock`'s own shape, one stale and one already correct. */
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "packages/action": {
      "name": "@ultimat3/action",
      "version": "3.0.0",
      "dependencies": {
        "@ultimat3/core": "2.0.0",
        "@ultimat3/schema": "3.0.0",
      },
    },
    "packages/core": {
      "name": "@ultimat3/core",
      "version": "3.0.0",
    },
  },
}
`;

const DECLARED = {
  action: { '@ultimat3/core': '3.0.0', '@ultimat3/schema': '3.0.0' },
};

describe('correcting the recorded ranges', () => {
  test('a range the manifest disagrees with is rewritten, and reported', () => {
    const { text, edits } = correctLockfile(LOCK, DECLARED);
    expect(edits).toEqual([
      { pkg: 'action', dep: '@ultimat3/core', locked: '2.0.0', declared: '3.0.0' },
    ]);
    expect(text).toContain('"@ultimat3/core": "3.0.0"');
    expect(text).not.toContain('"2.0.0"');
  });

  test('a range that already agrees is not an edit — the pass is idempotent', () => {
    const once = correctLockfile(LOCK, DECLARED);
    const twice = correctLockfile(once.text, DECLARED);
    expect(twice.edits).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  test('a workspace with no manifest entry is left exactly as found', () => {
    // The lockfile is the authority on nothing; a block this pass cannot check, it does not touch.
    const { text, edits } = correctLockfile(LOCK, {});
    expect(edits).toEqual([]);
    expect(text).toBe(LOCK);
  });

  test('only the @ultimat3 ranges move — an external pin is not this pass to change', () => {
    // The whole reason this is surgical: `rm bun.lock && bun install` also drags every external
    // dependency to its newest matching release, which on 2026-08-19 moved Biome two patches.
    const withExternal = LOCK.replace(
      '"@ultimat3/schema": "3.0.0",',
      '"@ultimat3/schema": "3.0.0",\n        "@biomejs/biome": "2.5.5",',
    );
    const { text } = correctLockfile(withExternal, DECLARED);
    expect(text).toContain('"@biomejs/biome": "2.5.5"');
  });

  test('a package.json range the lockfile has no line for adds nothing', () => {
    // The pass rewrites what is recorded; it never invents an edge, because a missing edge is a
    // question for `bun install`, not for a text rewrite.
    const { text, edits } = correctLockfile(LOCK, {
      action: { '@ultimat3/core': '3.0.0', '@ultimat3/nothing': '3.0.0' },
    });
    // The one real correction still happens; the edge the lockfile never recorded is not invented.
    expect(edits.map((edit) => edit.dep)).toEqual(['@ultimat3/core']);
    expect(text).not.toContain('@ultimat3/nothing');
  });
});
