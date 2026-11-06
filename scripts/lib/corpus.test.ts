// The `tests` scope is every test file a guard over tests must read. It globbed `src/` and
// `scripts/` only, so the fifteen suites under `packages/*/e2e/` were invisible to
// `test-bare-error` and `test-fix-citations` — each answered green over files it never opened.

import { expect, test } from 'bun:test';
import { CORPUS_PATTERNS, CORPUS_READ_BATCH, corpus } from './corpus';
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

test(
  'a scope larger than one read batch comes back whole, each file beside its own path',
  async () => {
    const files = await corpus(repoRoot(), 'shipped');
    // The repository is many batches; a batch boundary that shifted the texts would pair a path
    // with its neighbour's source.
    expect(files.length).toBeGreaterThan(CORPUS_READ_BATCH * 4);
    for (const at of [0, CORPUS_READ_BATCH - 1, CORPUS_READ_BATCH, files.length - 1]) {
      const file = files[at];
      if (file === undefined) return expect.unreachable('the index is inside the scope');
      expect(file.source).toBe(await Bun.file(`${repoRoot()}/${file.path}`).text());
    }
  },
  REPO_SCAN_TIMEOUT_MS,
);
