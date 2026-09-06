// Two questions, and the second is the one the hand-listed set got wrong. Is every noisy directory
// ruled out — and is a directory ruled out only where the app's OWN `.gitignore` rules it out? A
// wrongly-excluded directory is worse than a wrongly-included one: the dev loop silently stops
// reloading for a file the author is editing, and nothing anywhere says so.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no directory-create, file-write or recursive-remove primitive — `Bun.write`
// creates parents for a FILE only, and a fixture tree needs empty directories too.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ALWAYS_IGNORED_DIRECTORIES, devIgnore } from './dev-watch';

function fixture(name: string, gitignore?: string): string {
  const root = join(
    process.env['TMPDIR'] ?? '/tmp',
    `x-dev-watch-${name}-${process.pid}-${Bun.nanoseconds()}`,
  );
  // The marker stops the upward walk here, so no ancestor of TMPDIR can decide a case below.
  mkdirSync(join(root, '.git'), { recursive: true });
  if (gitignore !== undefined) writeFileSync(join(root, '.gitignore'), gitignore);
  return root;
}

const SCAFFOLD =
  'node_modules/\n.x/\n/dist/\npackages/*/dist/\n*.tsbuildinfo\n.env\n.env.*.local\n/coverage/\nplaywright-report/\ntest-results/\n';

describe('devIgnore', () => {
  test('a source file under any surface is a reload', () => {
    const root = fixture('source', SCAFFOLD);
    const ignore = devIgnore(root);
    for (const file of [
      'apps/web/app/feed/page.tsx',
      'apps/web/site/pricing/contact-sales.island.tsx',
      'apps/web/shared/global.scss',
      'packages/db/src/entity.ts',
      'app.config.ts',
      // The watcher's own input: an edit here changes the ignore set, so it can never be ignored.
      '.gitignore',
    ]) {
      expect(ignore.ignores(file, false)).toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  });

  // The floor holds with no ignore file at all, because not every app's names `.git` or `.x` — and
  // git never names `.git` in one.
  test('the framework floor applies at any depth with no ignore file', () => {
    const root = fixture('floor');
    const ignore = devIgnore(root);
    for (const file of [
      '.git/index',
      '.git/refs/heads/main',
      '.personal/fleet.yml',
      '.claude/worktrees/agent-a/apps/web/app/feed/page.tsx',
      '.x/build-stats.json',
      'apps/web/node_modules/x/index.js',
    ]) {
      expect(ignore.ignores(file, false)).toBe(true);
    }
    rmSync(root, { recursive: true, force: true });
  });

  // The substring bug, both directions. `includes('node_modules')` excluded the first and
  // `includes('.x/')` the second, so an author editing either got no reload and no message.
  test('a directory that merely CONTAINS a floor name is still a reload', () => {
    const root = fixture('substring');
    const ignore = devIgnore(root);
    for (const file of [
      'docs/my-node_modules-notes/page.md',
      'apps/web/app/.xyz/page.tsx',
      'apps/web/app/git/page.tsx',
    ]) {
      expect(ignore.ignores(file, false)).toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  });

  // The reason `dist` and `coverage` left the floor: hand-listed, they matched at any depth, so an
  // app's own `/dist` or `/coverage` ROUTE never reloaded and nothing said why.
  test('build output is ignored only where the app’s own ignore file says so', () => {
    const rooted = devIgnore(fixture('rooted', SCAFFOLD));
    expect(rooted.ignores('coverage/lcov.info', false)).toBe(true);
    expect(rooted.ignores('dist/index.js', false)).toBe(true);
    expect(rooted.ignores('apps/web/site/coverage/page.tsx', false)).toBe(false);
    expect(rooted.ignores('apps/web/site/dist/page.tsx', false)).toBe(false);

    const silent = devIgnore(fixture('silent'));
    expect(silent.ignores('coverage/lcov.info', false)).toBe(false);
    expect(silent.ignores('dist/index.js', false)).toBe(false);
  });

  // Measured: `touch examples/dummy/tsconfig.tsbuildinfo` — the file `bun run typecheck` rewrites —
  // logged `reloaded tsconfig.tsbuildinfo in 113ms`, a full appManifest() plus buildIslands().
  test('a git-ignored build artifact is not a source change', () => {
    const ignore = devIgnore(fixture('artifact', SCAFFOLD));
    expect(ignore.ignores('tsconfig.tsbuildinfo', false)).toBe(true);
    expect(ignore.ignores('apps/web/tsconfig.tsbuildinfo', false)).toBe(true);
    expect(ignore.ignores('playwright-report/index.html', false)).toBe(true);
    expect(ignore.ignores('test-results/.last-run.json', false)).toBe(true);
    expect(ignore.ignores('.env.development.local', false)).toBe(true);
  });

  test('the floor is the rule: every entry is matched as its own segment', () => {
    const ignore = devIgnore(fixture('list'));
    for (const directory of ALWAYS_IGNORED_DIRECTORIES) {
      expect(ignore.ignores(`apps/web/${directory}/thing`, false)).toBe(true);
      expect(ignore.ignores(`apps/web/${directory}-notes/thing`, false)).toBe(false);
    }
  });

  test('a backslash separator splits the same way, so the rule exists on Windows too', () => {
    const ignore = devIgnore(fixture('windows'));
    expect(ignore.ignores('.claude\\worktrees\\agent-a\\apps\\web\\app\\page.tsx', false)).toBe(
      true,
    );
    expect(ignore.ignores('apps\\web\\app\\page.tsx', false)).toBe(false);
  });

  test('a directory-only rule is asked about a DIRECTORY, and answers differently', () => {
    const ignore = devIgnore(fixture('kind', '/coverage/\n'));
    expect(ignore.ignores('coverage', true)).toBe(true);
    // A FILE called `coverage` is not the directory the rule names, and git agrees.
    expect(ignore.ignores('coverage', false)).toBe(false);
  });
});
