import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { dirname, join } from 'node:path';
import { clearPrerenderOut } from './prerender-out';

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('unit · a static export never ships a deleted route (row g)', () => {
  test('the export directory is emptied before a build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-prerender-out-'));
    roots.push(root);
    const out = join(root, '.x/static');
    await Bun.write(join(out, 'deleted-route/index.html'), '<p>gone</p>');
    await clearPrerenderOut(out, root);
    expect(await Bun.file(join(out, 'deleted-route/index.html')).exists()).toBe(false);
    expect(await Bun.file(join(root, '.x')).exists()).toBe(false);
  });

  test('the app root, or a directory above it, is refused and nothing is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-prerender-root-'));
    roots.push(root);
    await Bun.write(join(root, 'app.config.ts'), '');
    for (const out of [root, dirname(root), '/']) {
      await expect(clearPrerenderOut(out, root)).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    }
    expect(await Bun.file(join(root, 'app.config.ts')).exists()).toBe(true);
  });
});
