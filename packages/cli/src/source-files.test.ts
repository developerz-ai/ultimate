// The one source set three gate steps walk. A directory missing from it is a directory `filesize`,
// `errors` and `x i18n check` can never report on — a hole none of them can see from the inside.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no temp-directory API or recursive delete.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  eachSourceFile,
  isGenerated,
  isTest,
  isVendored,
  SOURCE_GLOBS,
  sortedPosix,
} from './source-files';

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

describe("unit · an app's own entry files and guards are source (s1-t5 gaps)", () => {
  // `filesize` and `errors` never saw a 900-line guard or an unrunnable `fix:` in the server
  // entry: `guards/*.ts`, `apps/*/server.ts` and `apps/*/prerender.ts` sat outside every glob.
  test('guards/*.ts, apps/*/server.ts and apps/*/prerender.ts are walked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-source-files-'));
    const files = [
      'guards/raw-colour.ts',
      'guards/raw-colour.test.ts',
      'apps/web/server.ts',
      'apps/web/prerender.ts',
      'apps/admin/server.ts',
      'apps/web/app/post/entity.ts',
    ];
    try {
      for (const path of [...files, 'apps/web/node_modules/x/server.ts', 'docker/x.ts']) {
        await Bun.write(join(root, path), 'export {};\n');
      }
      expect([...(await collect(root))].sort()).toEqual([...files].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('unit · a Windows glob answer is the same source set', () => {
  test('backslash answers come out POSIX, in the order their POSIX spelling sorts', () => {
    // `\` sorts after `1`, `/` before it: one tree, one order, on either host.
    expect(
      sortedPosix([
        'guards\\untranslated-string.ts',
        'packages\\a1\\src\\x.ts',
        'packages\\a\\src\\x.ts',
      ]),
    ).toEqual(['guards/untranslated-string.ts', 'packages/a/src/x.ts', 'packages/a1/src/x.ts']);
  });
});
