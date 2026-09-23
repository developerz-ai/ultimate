// Row b: `X_GENERATE_CONFLICT`'s fix dropped `--feature`/`--surface`/`--at`, so RUNNING it wrote a
// new slice beside the one that conflicted. The fix is run here, not read.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const contextFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

/** The fix line as argv: the command before a `#` comment, `x` dropped, quotes stripped. */
const argvOf = (fix: string): readonly string[] =>
  (fix.split('#')[0] ?? '')
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((word) => word.replace(/^'(.*)'$/, '$1'));

describe('unit · x g conflict fix reproduces the invocation, every flag included', () => {
  test('x g action publish --feature post, twice, then its printed fix, overwrites the same path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-generate-fix-'));
    try {
      await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
      // The slice exists: `--feature` writes INTO one and refuses one that is not there.
      await Bun.write(join(root, 'apps/web/app/post/.keep'), '');
      const argv = ['g', 'action', 'publish', '--feature', 'post'];
      const first = await generateCommand.run(contextFor(argv, root));
      const written = (first.data as { files: readonly string[] }).files;
      expect(written.length).toBeGreaterThan(0);

      const second = await generateCommand.run(contextFor(argv, root));
      const fix = second.findings?.find((one) => one.code === 'X_GENERATE_CONFLICT')?.fix ?? '';
      expect(fix).toContain('--feature post');

      const conflicted = second.findings?.find((one) => one.code === 'X_GENERATE_CONFLICT')?.at;
      const forced = await generateCommand.run(contextFor(argvOf(fix), root));
      expect(forced.ok).toBe(true);
      // The file that conflicted is the one overwritten; the slice's own foundation files are
      // the author's after the first run, and `--force` leaves them alone.
      const rewritten = (forced.data as { files: readonly string[] }).files;
      expect(rewritten).toContain(conflicted ?? '');
      expect(rewritten.every((path) => written.includes(path))).toBe(true);
      // One slice, the one that conflicted — the fix wrote nowhere new.
      expect(await readdir(join(root, 'apps/web/app'))).toEqual(['post']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('unit · x g --feature never invents the slice it names', () => {
  test('a feature with no directory is X_FEATURE_UNKNOWN, and nothing is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-generate-feature-'));
    try {
      await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
      const refused = await generateCommand
        .run(contextFor(['g', 'task', 'nightly', '--feature', 'reports'], root))
        .catch((error: unknown) => error);
      expect((refused as { code?: string }).code).toBe('X_FEATURE_UNKNOWN');
      expect((refused as { fix?: string }).fix).toBe('x g resource reports');
      expect(await readdir(root)).toEqual(['app.config.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('with no --feature, a job writes its own slice and no entity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-generate-neutral-'));
    try {
      await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
      const result = await generateCommand.run(contextFor(['g', 'task', 'nightly'], root));
      const files = (result.data as { files: readonly string[] }).files;
      expect(files).toContain('apps/web/app/nightly/tasks/nightly.ts');
      expect(files.some((path) => path.endsWith('/entity.ts'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
