// The refusals `scripts/release.ts` makes before it rewrites 47 files: a dirty tree, and a version
// that does not move forward. Pure inputs throughout — the only other way to see one fail is to
// run a release over a working tree somebody was still editing.

import { describe, expect, test } from 'bun:test';
import {
  annotatedTagCommand,
  compareReleaseVersions,
  DIRTY_PATHS_SHOWN,
  dirtyPaths,
  treeDirtyFindings,
} from './release-preflight';

const RERUN = 'bun run scripts/release.ts --bump minor';

describe('unit · a release refuses a working tree with changes in it', () => {
  test('a clean tree is no finding', () => {
    expect(treeDirtyFindings('', RERUN)).toEqual([]);
    expect(treeDirtyFindings('\n', RERUN)).toEqual([]);
  });

  test('every porcelain status shape yields its path, the leading space included', () => {
    const porcelain = [
      ' M CHANGELOG.md',
      'M  scripts/release.ts',
      '?? scratch.ts',
      'R  a.ts -> b.ts',
    ]
      .concat('MM packages/core/package.json')
      .join('\n');
    expect(dirtyPaths(porcelain)).toEqual([
      'CHANGELOG.md',
      'scripts/release.ts',
      'scratch.ts',
      'a.ts -> b.ts',
      'packages/core/package.json',
    ]);
  });

  test('a dirty tree is refused with the paths in the cause and the rerun in the fix', () => {
    const [finding, ...rest] = treeDirtyFindings(' M CHANGELOG.md\n?? scratch.ts', RERUN);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_RELEASE_TREE_DIRTY');
    expect(finding?.cause).toContain('CHANGELOG.md');
    expect(finding?.cause).toContain('scratch.ts');
    expect(finding?.fix).toBe(`git stash -u && ${RERUN}`);
  });

  test('a long list is capped, and says how many it left out', () => {
    const porcelain = Array.from({ length: DIRTY_PATHS_SHOWN + 3 }, (_, i) => `?? f${i}.ts`).join(
      '\n',
    );
    const cause = treeDirtyFindings(porcelain, RERUN)[0]?.cause ?? '';
    expect(cause).toContain('f0.ts');
    expect(cause).not.toContain(`f${DIRTY_PATHS_SHOWN}.ts`);
    expect(cause).toContain('3 more');
  });

  // Fail closed: a tree this could not read is not a tree it knows to be clean.
  test('a git status that could not run is a refusal, not a pass', () => {
    const [finding] = treeDirtyFindings(undefined, RERUN);
    expect(finding?.code).toBe('X_RELEASE_TREE_DIRTY');
    expect(finding?.fix).toContain('git status --porcelain');
  });
});

describe('unit · release versions compare in semver order', () => {
  test('numeric, never lexicographic', () => {
    expect(compareReleaseVersions('10.0.0', '9.9.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareReleaseVersions('1.1.9', '1.2.0')).toBeLessThan(0);
  });

  test('a prerelease sits below its own release', () => {
    expect(compareReleaseVersions('2.0.0', '2.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareReleaseVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
    expect(compareReleaseVersions('2.0.0-rc.2', '2.0.0-rc.1')).toBeGreaterThan(0);
  });
});

describe('unit · every tag command this script prints is annotated', () => {
  // `--follow-tags` pushes annotated tags only, so a lightweight `git tag v4.0.0` stayed local and
  // the Release could not be created against a ref the remote did not have.
  test('-a with a message, pushed by name', () => {
    expect(annotatedTagCommand('1.3.0')).toBe(
      'git tag -a v1.3.0 -m v1.3.0 && git push origin v1.3.0',
    );
  });
});
