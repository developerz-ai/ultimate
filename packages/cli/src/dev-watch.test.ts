// One question, in two halves: is every noisy directory ruled out, and is the rule a PATH SEGMENT
// rather than a substring? The second half is what the previous `includes()` got wrong, and a
// wrongly-excluded directory is worse than a wrongly-included one — the dev loop silently stops
// reloading for a file the author is editing.

import { describe, expect, test } from 'bun:test';
import { IGNORED_DIRECTORIES, isIgnoredPath } from './dev-watch';

describe('isIgnoredPath', () => {
  test('a source file under any surface is a reload', () => {
    for (const file of [
      'apps/web/app/feed/page.tsx',
      'apps/web/site/pricing/contact-sales.island.tsx',
      'apps/web/shared/global.scss',
      'packages/db/src/entity.ts',
      'app.config.ts',
    ]) {
      expect(isIgnoredPath(file)).toBe(false);
    }
  });

  // Each of these ran a full `appManifest()` + `buildIslands()` in ai-maxxing, where `.git/`,
  // `.personal/`, `.claude/worktrees/` and `coverage/` all live beside the app.
  test('a write in a noisy directory is not a reload, at any depth', () => {
    for (const file of [
      '.git/index',
      '.git/refs/heads/main',
      '.personal/fleet.yml',
      '.claude/worktrees/agent-a/apps/web/app/feed/page.tsx',
      'coverage/lcov.info',
      'dist/index.js',
      '.x/build-stats.json',
      'apps/web/node_modules/x/index.js',
    ]) {
      expect(isIgnoredPath(file)).toBe(true);
    }
  });

  // The substring bug, both directions. `includes('node_modules')` excluded the first and
  // `includes('.x/')` the second, so an author editing either got no reload and no message.
  test('a directory that merely CONTAINS an ignored name is still a reload', () => {
    for (const file of [
      'docs/my-node_modules-notes/page.md',
      'apps/web/app/.xyz/page.tsx',
      'apps/web/app/git/page.tsx',
      'apps/web/app/distribution/page.tsx',
      'apps/web/app/coverage-report/page.tsx',
    ]) {
      expect(isIgnoredPath(file)).toBe(false);
    }
  });

  test('a backslash separator splits the same way, so the rule exists on Windows too', () => {
    expect(isIgnoredPath('.claude\\worktrees\\agent-a\\apps\\web\\app\\page.tsx')).toBe(true);
    expect(isIgnoredPath('apps\\web\\app\\page.tsx')).toBe(false);
  });

  test('the list is the rule: every entry is matched as its own segment', () => {
    for (const directory of IGNORED_DIRECTORIES) {
      expect(isIgnoredPath(`apps/web/${directory}/thing`)).toBe(true);
      expect(isIgnoredPath(`apps/web/${directory}-notes/thing`)).toBe(false);
    }
  });
});
