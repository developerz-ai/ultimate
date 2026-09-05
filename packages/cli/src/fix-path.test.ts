// The rule's own unit: which citations this repo may judge, and what it answers for each. Every
// exclusion has a case, because an exclusion nobody pinned is the one a later widening deletes.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive, and this test builds a repo-relative root.
import { join } from 'node:path';
import { citedPathProblem, FILE_TOKEN_PATTERN, pathCitations } from './fix-path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('unit · which citations are judgeable', () => {
  test('reads a repo path and a glob', () => {
    expect(pathCitations('open packages/cli/src/fix-path.ts', REPO_ROOT)).toEqual([
      'packages/cli/src/fix-path.ts',
    ]);
    expect(pathCitations('set the version in packages/*/package.json', REPO_ROOT)).toEqual([
      'packages/*/package.json',
    ]);
  });

  // Each of these resolves against something other than the root the gate is running in, so a
  // finding about one would be a finding nobody can act on. All three are shipped fix lines.
  test('never judges a scoped specifier, a dot-relative path, or an app-facing one', () => {
    expect(pathCitations("add `@use '@ultimat3/ui/global.scss';`", REPO_ROOT)).toEqual([]);
    expect(pathCitations("add `import './global.scss';`", REPO_ROOT)).toEqual([]);
    expect(pathCitations("register it in its package's src/errors.ts", REPO_ROOT)).toEqual([]);
    expect(pathCitations('open it in apps/web/server.ts', REPO_ROOT)).toEqual([]);
  });

  test('never judges a path under a directory the root .gitignore never commits', async () => {
    // Measured 2026-09-05: an app's fixes name `.personal/fleet.yml`, the private fleet file that
    // exists on every developer's disk and on no CI runner — the repo's own `.gitignore` says so.
    // A fixture root beside this file, Bun-only: the node-import ratchet counts every `node:` site.
    const root = join(import.meta.dir, '.fix-path-private-fixture');
    try {
      await Bun.write(
        join(root, '.gitignore'),
        '# private\n.personal/\n/tmp/\nnode_modules\n!keep.md\n*.log\n',
      );
      await Bun.write(join(root, 'scripts', 'fleet', '.keep'), '');
      expect(
        pathCitations('edit .personal/fleet.yml, then bun scripts/fleet/list.ts', root),
      ).toEqual(['scripts/fleet/list.ts']);
      expect(pathCitations('see tmp/notes.md and node_modules/x/y.ts', root)).toEqual([]);
      expect(await citedPathProblem('write it in .personal/providers.yml', root)).toBeUndefined();
      // A directory that is not ignored is still judged: the rule errs towards judging.
      expect(await citedPathProblem('see scripts/missing.ts', root)).toContain(
        'scripts/missing.ts',
      );
    } finally {
      await Bun.$`rm -rf ${root}`.quiet();
    }
  });

  test('never judges a URL that is shaped like a path', () => {
    expect(pathCitations('read https://example.test/errors/x_code.md', REPO_ROOT)).toEqual([]);
  });

  // The caller blanks `${…}` before this runs; what is left is not a path this can resolve.
  test('never judges a path assembled at run time', () => {
    expect(pathCitations('open packages/<value>/src/errors.ts', REPO_ROOT)).toEqual([]);
  });
});

describe('unit · resolving one', () => {
  test('a path this repo holds is no problem', async () => {
    expect(await citedPathProblem('open packages/cli/src/fix-path.ts', REPO_ROOT)).toBeUndefined();
  });

  // The whole point: a fabricated path in a directory that really exists passed every gate the
  // repo had, because only `x <command>` citations were ever resolved.
  test('a fabricated path in a real directory is a problem naming it', async () => {
    const problem = await citedPathProblem('open packages/cli/src/no-such-file.ts', REPO_ROOT);
    expect(problem).toBe(
      'cites "packages/cli/src/no-such-file.ts", which is not a file in this repository',
    );
  });

  test('a glob must match at least one file', async () => {
    expect(await citedPathProblem('edit packages/*/package.json', REPO_ROOT)).toBeUndefined();
    expect(await citedPathProblem('edit packages/*/no-such-file.json', REPO_ROOT)).toBe(
      'cites "packages/*/no-such-file.json", which matches no file',
    );
  });

  test('a directory is a legitimate citation', async () => {
    expect(
      await citedPathProblem('the results under scripts/bench/results/x.json', REPO_ROOT),
    ).toBe('cites "scripts/bench/results/x.json", which is not a file in this repository');
    expect(await citedPathProblem('open docs/idea/02-primitives.md', REPO_ROOT)).toBeUndefined();
  });

  test('reports the FIRST unresolved citation only — one finding per fix line', async () => {
    const problem = await citedPathProblem(
      'copy packages/cli/src/a-missing.ts into packages/cli/src/b-missing.ts',
      REPO_ROOT,
    );
    expect(problem).toContain('a-missing.ts');
    expect(problem).not.toContain('b-missing.ts');
  });
});

describe('unit · the shared vocabulary', () => {
  // Two extension lists would mean a token that satisfies the instruction rule and is invisible to
  // this one, which is the hole the whole file exists to close.
  test('the instruction rule and this one read the same file token', () => {
    const token = new RegExp(FILE_TOKEN_PATTERN);
    expect(token.test('packages/cli/src/fix-path.ts')).toBe(true);
    expect(token.test('app.config.ts')).toBe(false);
  });
});
