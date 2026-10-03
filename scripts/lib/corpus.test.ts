// The `tests` scope is every test file a guard over tests must read. It globbed `src/` and
// `scripts/` only, so the fifteen suites under `packages/*/e2e/` were invisible to
// `test-bare-error` and `test-fix-citations` — each answered green over files it never opened.

import { expect, test } from 'bun:test';
import { CORPUS_PATTERNS, corpus } from './corpus';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

test(
  'the tests scope reads the e2e suites, and only test files from them',
  async () => {
    const paths = (await corpus(repoRoot(), 'tests')).map((file) => file.path);
    const e2e = paths.filter((path) => /^packages\/[^/]+\/e2e\//.test(path));
    expect(e2e.length).toBeGreaterThan(0);
    // `client-navigation-fixture.ts` sits beside them and is not a suite.
    expect(e2e.every((path) => /\.test\.tsx?$/.test(path))).toBe(true);
  },
  REPO_SCAN_TIMEOUT_MS,
);

test('source already reads e2e, so the two scopes agree on where tests live', () => {
  expect(CORPUS_PATTERNS.source).toContain('packages/*/e2e/**/*.{ts,tsx}');
  expect(CORPUS_PATTERNS.tests).toContain('packages/*/e2e/**/*.test.{ts,tsx}');
});
