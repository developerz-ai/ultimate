// The rules a `.gitignore` really states, against the ones a hand-rolled reader assumes. Every case
// here is a line some app's ignore file actually holds: an unanchored name matching at any depth, a
// rooted one matching only at the top, a negation re-including one file, and a directory-only form
// that must not swallow a FILE of the same name.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no directory-create, file-write or recursive-remove primitive — `Bun.write`
// creates parents for a FILE only, and a fixture tree needs empty directories too.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ignoreScopes, isGitIgnored, parseGitignore } from './gitignore';

const scratch = (name: string): string => {
  const dir = join(
    process.env['TMPDIR'] ?? '/tmp',
    `x-gitignore-${name}-${process.pid}-${Bun.nanoseconds()}`,
  );
  // A `.git` marker, so the upward walk stops here and no ancestor of TMPDIR can decide a case.
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
};

describe('parseGitignore', () => {
  test('comments, blank lines and trailing whitespace carry no rule', () => {
    expect(parseGitignore('# a comment\n\n   \ndist/\n')).toHaveLength(1);
  });

  test('each form is read off the line, not guessed', () => {
    const [unanchored, rooted, nested, negated] = parseGitignore(
      'coverage/\n/tmp\na/b.log\n!keep.md',
    );
    expect(unanchored).toEqual({
      glob: 'coverage',
      anchored: false,
      directoryOnly: true,
      negated: false,
    });
    expect(rooted).toEqual({ glob: 'tmp', anchored: true, directoryOnly: false, negated: false });
    expect(nested).toEqual({
      glob: 'a/b.log',
      anchored: true,
      directoryOnly: false,
      negated: false,
    });
    expect(negated).toEqual({
      glob: 'keep.md',
      anchored: false,
      directoryOnly: false,
      negated: true,
    });
  });

  test('an escaped # or ! is a filename, never a comment or a negation', () => {
    expect(parseGitignore('\\#notes.md\n\\!bang.md')).toEqual([
      { glob: '#notes.md', anchored: false, directoryOnly: false, negated: false },
      { glob: '!bang.md', anchored: false, directoryOnly: false, negated: false },
    ]);
  });
});

describe('isGitIgnored', () => {
  test('an unanchored name matches at any depth, a rooted one only at the root', () => {
    const root = scratch('anchor');
    writeFileSync(join(root, '.gitignore'), 'coverage/\n/dist/\n');
    const scopes = ignoreScopes(root);
    expect(isGitIgnored(scopes, join(root, 'coverage'), true)).toBe(true);
    expect(isGitIgnored(scopes, join(root, 'apps/web/site/coverage'), true)).toBe(true);
    expect(isGitIgnored(scopes, join(root, 'dist'), true)).toBe(true);
    // The finding this whole file exists for: a ROOTED build-output rule must never swallow an
    // app's own `/dist` route.
    expect(isGitIgnored(scopes, join(root, 'apps/web/site/dist/page.tsx'), false)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('a directory-only pattern never matches a file of the same name', () => {
    const root = scratch('dironly');
    writeFileSync(join(root, '.gitignore'), 'build/\n');
    const scopes = ignoreScopes(root);
    expect(isGitIgnored(scopes, join(root, 'build'), true)).toBe(true);
    expect(isGitIgnored(scopes, join(root, 'build'), false)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('everything under an ignored directory is ignored', () => {
    const root = scratch('under');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const scopes = ignoreScopes(root);
    expect(isGitIgnored(scopes, join(root, 'node_modules/pkg/index.js'), false)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('a later negation re-includes what an earlier line ignored', () => {
    const root = scratch('negate');
    writeFileSync(join(root, '.gitignore'), '.env\n.env.*\n!.env.example\n');
    const scopes = ignoreScopes(root);
    expect(isGitIgnored(scopes, join(root, '.env.local'), false)).toBe(true);
    expect(isGitIgnored(scopes, join(root, '.env.example'), false)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('globs read `*`, `**` and `?`', () => {
    const root = scratch('glob');
    writeFileSync(join(root, '.gitignore'), '*.tsbuildinfo\n**/test-results/\nnote?.md\n');
    const scopes = ignoreScopes(root);
    expect(isGitIgnored(scopes, join(root, 'tsconfig.tsbuildinfo'), false)).toBe(true);
    expect(isGitIgnored(scopes, join(root, 'apps/web/tsconfig.tsbuildinfo'), false)).toBe(true);
    expect(isGitIgnored(scopes, join(root, 'e2e/test-results/run.json'), false)).toBe(true);
    expect(isGitIgnored(scopes, join(root, 'note1.md'), false)).toBe(true);
    expect(isGitIgnored(scopes, join(root, 'note10.md'), false)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('a path outside every scope is nobody\u2019s business', () => {
    const root = scratch('outside');
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    const scopes = ignoreScopes(root);
    expect(isGitIgnored(scopes, '/elsewhere/dist/index.js', false)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('ignoreScopes', () => {
  // `examples/dummy` has no `.gitignore` of its own and every rule that governs it lives in the
  // repository root's. Reading only the app root's file is why `touch tsconfig.tsbuildinfo` reloaded.
  test('an app inside a repository inherits the repository\u2019s ignore file', () => {
    const repo = scratch('chain');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'examples/app'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), '*.tsbuildinfo\n');
    const scopes = ignoreScopes(join(repo, 'examples/app'));
    expect(scopes.map((scope) => scope.base)).toEqual([repo]);
    expect(isGitIgnored(scopes, join(repo, 'examples/app/tsconfig.tsbuildinfo'), false)).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test('the app\u2019s own file wins over the repository\u2019s, because it is read last', () => {
    const repo = scratch('override');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'examples/app'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'notes/\n');
    writeFileSync(join(repo, 'examples/app/.gitignore'), '!notes/\n');
    const app = join(repo, 'examples/app');
    const scopes = ignoreScopes(app);
    expect(scopes.map((scope) => scope.base)).toEqual([repo, app]);
    expect(isGitIgnored(scopes, join(app, 'notes'), true)).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  test('the walk stops at the repository, never at the filesystem root', () => {
    const repo = scratch('stop');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(ignoreScopes(repo)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });
});
