// The one source set three gate steps walk. A directory missing from it is a directory `filesize`,
// `errors` and `x i18n check` can never report on — a hole none of them can see from the inside.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { eachSourceFile, isGenerated, isTest, isVendored, SOURCE_GLOBS } from './source-files';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

const collect = async (root: string): Promise<readonly string[]> => {
  const paths: string[] = [];
  for await (const path of eachSourceFile(root)) paths.push(path);
  return paths;
};

describe('unit · the source set', () => {
  test('packages/*/e2e is shipped source, not a directory the gate walks past', async () => {
    const paths = await collect(REPO_ROOT);
    expect(paths).toContain('packages/cli/src/bin.ts');
    // Three packages carry one. `packages/core/e2e/version.e2e.test.ts` could hold a 900-line file
    // or an unrunnable `fix:` and no step would say so.
    expect(paths.filter((path) => /^packages\/[^/]+\/e2e\//.test(path)).length).toBeGreaterThan(0);
    expect(SOURCE_GLOBS).toContain('packages/*/e2e/**/*.{ts,tsx}');
  });

  test('every path is yielded once, however many globs match it', async () => {
    const paths = await collect(REPO_ROOT);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('vendored, generated and test paths keep their own answers', () => {
    expect(isVendored('packages/cli/node_modules/x/index.ts')).toBe(true);
    expect(isGenerated('packages/ui/src/scss.d.ts')).toBe(true);
    expect(isTest('packages/core/e2e/version.e2e.test.ts')).toBe(true);
    expect(isTest('packages/core/src/errors.ts')).toBe(false);
  });
});
