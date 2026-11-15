// The template tree a release tag held, extracted WITH every module outside `templates/` its
// scaffold-guards graph imports — so `guard-refresh-forms.ts` can load the tag's guards once the
// templates import a leaf beside them (`../guards-shipped-names`, from 31.28.0).

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove API.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  extractTemplates,
  gitTreeSource,
  outsideImports,
  SCRATCH,
  TEMPLATES,
  worktreeSource,
} from './guard-refresh-archive';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { ScriptError } from './script-error';

// Archives and imports a real tree: the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/**
 * Under `SCRATCH`, where `guard-refresh-forms.ts` extracts: the closure reaches
 * modules that import `@ultimat3/*`, which resolve only from inside the checkout.
 */
const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const cache = join(repoRoot(), SCRATCH);
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'test-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('the template closure a tag needs', () => {
  test('a runtime import that leaves the extracted tree is named; type-only and present are not', () => {
    const files = new Map([
      [
        `${TEMPLATES}/a.ts`,
        "import { x } from '../leaf';\nimport { y } from './b';\nimport type { T } from '../types';\n",
      ],
      [`${TEMPLATES}/b.ts`, "export { z } from '../../other/c';\n"],
    ]);
    expect(outsideImports(files)).toEqual(['packages/cli/other/c', 'packages/cli/src/leaf']);
  });

  test('the tree as 31.28.0 will tag it loads, its leaf brought along', async () => {
    await withDir(async (dir) => {
      await extractTemplates(worktreeSource(repoRoot()), dir);
      const guards = await import(join(dir, TEMPLATES, 'scaffold-guards.ts'));
      expect(guards.SHIPPED_GUARD_NAMES).toContain('runtime-pin');
      expect(await Bun.file(join(dir, 'packages/cli/src/guards-shipped-names.ts')).exists()).toBe(
        true,
      );
    });
  });

  // HEAD as if it were the tag: the leaf `scaffold-guards.ts` imports came only from 31.28.0.
  test('git archive HEAD extracts a tree that loads, every module outside templates/ with it', async () => {
    await withDir(async (dir) => {
      await extractTemplates(gitTreeSource(repoRoot(), 'HEAD'), dir);
      const guards = await import(join(dir, TEMPLATES, 'scaffold-guards.ts'));
      expect(guards.SHIPPED_GUARD_NAMES.length).toBeGreaterThan(20);
    });
  });

  test('a ref git cannot archive is a coded error, never a silent empty tree', async () => {
    await withDir(async (dir) => {
      const failure = await extractTemplates(gitTreeSource(repoRoot(), 'v0.0.0-none'), dir).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ScriptError);
      expect((failure as ScriptError).code).toBe('X_GUARD_FORMS_ARCHIVE_FAILED');
    });
  });
});
