import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { dirname, join } from 'node:path';
import { clearPrerenderOut, EXPORT_MARKER } from './prerender-out';

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A scratch app: `app.config.ts`, a page, and the embedded dev database `.x/pgdata` holds. */
const scratchApp = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'x-prerender-out-'));
  roots.push(root);
  await Bun.write(join(root, 'app.config.ts'), '');
  await Bun.write(join(root, 'apps/web/site/page.tsx'), 'export {};\n');
  await Bun.write(join(root, '.x/pgdata/PG_VERSION'), '17\n');
  return root;
};

const exists = (path: string): Promise<boolean> => Bun.file(path).exists();

describe('unit · a static export never ships a deleted route (row g)', () => {
  test('the export directory is emptied before a build, and marked as the build`s own', async () => {
    const root = await scratchApp();
    const out = join(root, '.x/static');
    await Bun.write(join(out, 'deleted-route/index.html'), '<p>gone</p>');
    await clearPrerenderOut(out, root);
    expect(await exists(join(out, 'deleted-route/index.html'))).toBe(false);
    expect(await exists(join(out, EXPORT_MARKER))).toBe(true);
    expect(await exists(join(root, '.x/pgdata/PG_VERSION'))).toBe(true);
  });

  test('a directory a previous build marked is emptied, wherever it is', async () => {
    const root = await scratchApp();
    const out = join(root, 'public-export');
    await clearPrerenderOut(out, root);
    await Bun.write(join(out, 'old/index.html'), '<p>old</p>');
    await clearPrerenderOut(out, root);
    expect(await exists(join(out, 'old/index.html'))).toBe(false);
    expect(await exists(join(out, EXPORT_MARKER))).toBe(true);
  });

  test('an empty or absent directory is the build`s to take', async () => {
    const root = await scratchApp();
    await mkdir(join(root, 'empty'));
    for (const out of [join(root, 'empty'), join(root, 'absent/nested')]) {
      await clearPrerenderOut(out, root);
      expect(await exists(join(out, EXPORT_MARKER))).toBe(true);
    }
  });
});

describe('unit · an export directory a build did not write is refused (s2-cli #2)', () => {
  test('the app root, or a directory above it, is refused and nothing is removed', async () => {
    const root = await scratchApp();
    for (const out of [root, dirname(root), '/']) {
      await expect(clearPrerenderOut(out, root)).rejects.toMatchObject({
        code: 'X_BUILD_OUT_UNSAFE',
      });
    }
    expect(await exists(join(root, 'app.config.ts'))).toBe(true);
  });

  // `x build --target static --out apps` deleted `apps/web/site/page.tsx`; `--out .x` deleted the
  // embedded dev database. Neither directory carries the build's marker.
  test.each([
    ['apps', 'apps/web/site/page.tsx'],
    ['.x', '.x/pgdata/PG_VERSION'],
    ['.x/pgdata', '.x/pgdata/PG_VERSION'],
    ['apps/web/site', 'apps/web/site/page.tsx'],
  ])('--out %s inside the root is refused and %s survives', async (dir, survivor) => {
    const root = await scratchApp();
    const thrown = await clearPrerenderOut(join(root, dir), root).catch((error: unknown) => error);
    expect(thrown).toBeUltimateError('X_BUILD_OUT_UNSAFE');
    expect(await exists(join(root, survivor))).toBe(true);
  });

  test('an unmarked directory outside the root is refused too, and its files stay', async () => {
    const root = await scratchApp();
    const elsewhere = await mkdtemp(join(tmpdir(), 'x-prerender-elsewhere-'));
    roots.push(elsewhere);
    await Bun.write(join(elsewhere, 'notes.txt'), 'mine');
    const thrown = await clearPrerenderOut(elsewhere, root).catch((error: unknown) => error);
    expect(thrown).toBeUltimateError('X_BUILD_OUT_UNSAFE');
    expect(await exists(join(elsewhere, 'notes.txt'))).toBe(true);
  });

  test('a file where the directory should be is refused, never deleted', async () => {
    const root = await scratchApp();
    const thrown = await clearPrerenderOut(join(root, 'app.config.ts'), root).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBeUltimateError('X_BUILD_OUT_UNSAFE');
    expect(await exists(join(root, 'app.config.ts'))).toBe(true);
  });

  // The default export directory predates the marker: a build from before it left `.x/static`
  // full and unmarked, and the next build must not refuse the path it chose itself.
  test('the default .x/static is the build`s own even before it carries the marker', async () => {
    const root = await scratchApp();
    await Bun.write(join(root, '.x/static/index.html'), '<p>old</p>');
    await clearPrerenderOut(join(root, '.x/static'), root);
    expect(await exists(join(root, '.x/static/index.html'))).toBe(false);
  });

  test('the fix names a directory the build may empty, quoted for the shell', async () => {
    const root = await scratchApp();
    const thrown = await clearPrerenderOut(join(root, 'apps'), root).catch(
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({ fix: 'x build --target static --out .x/static --json' });
    expect(String((thrown as { cause?: unknown }).cause)).toContain(join(root, 'apps'));
  });
});
