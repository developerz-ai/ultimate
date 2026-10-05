// TEST-ONLY. One shipped guard, written to a throwaway app root beside the files a case needs,
// and run through the seam `x verify`'s `boundaries` step calls. Shared by the seven stylesheet
// guards' tests: each asks the same question — does THIS guard, as emitted, refuse this tree —
// and a whole `x new` scaffold per case (166 files) is what made the older guard suites slow.

// why: Bun ships no temp-directory, symlink or mkdir API; `node:fs/promises` is the only one.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { guardFindings } from '../guards';
import type { Finding } from '../output';
import { shippedGuardFiles } from './scaffold-guards';

/** This repo's `@ultimat3/ui`, for a tree whose stylesheets `@use '@ultimat3/ui/tokens'`. */
const UI_PACKAGE = Bun.fileURLToPath(new URL('../../../ui', import.meta.url));

/** Make `@ultimat3/ui` resolve from `root`, as `bun install` would have. */
export async function linkUi(root: string): Promise<void> {
  await mkdir(join(root, 'node_modules/@ultimat3'), { recursive: true });
  await symlink(UI_PACKAGE, join(root, 'node_modules/@ultimat3/ui'));
}

/**
 * The findings of ONE shipped guard over `files`. `ui: true` links the token package first, which
 * a fixture needs only when a sheet in it uses the tokens and the guard compiles it.
 */
export async function shippedGuardFindings(
  name: string,
  files: Readonly<Record<string, string>>,
  options: { readonly ui?: boolean } = {},
): Promise<readonly Finding[]> {
  const root = await mkdtemp(join(tmpdir(), `x-guard-${name}-`));
  try {
    for (const file of shippedGuardFiles(name) ?? []) {
      if (!file.path.endsWith('.test.ts')) await Bun.write(join(root, file.path), file.contents);
    }
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    if (options.ui === true) await linkUi(root);
    return await guardFindings(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
