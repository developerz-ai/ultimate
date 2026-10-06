// The page runtime's chunk is recognised by ONE predicate, and nothing an island can be named
// makes an island entry look like it — the collision a `realtime-` prefix match had.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete, temp directory or symlink API — a second install needs all three.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: `node:os` — the temp directory's location; Bun exposes none.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { buildIslands } from './island-bundle';
import { isRuntimeChunk } from './island-runtime';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'runtime-chunk'));

/** An island NAMED like the runtime, reaching realtime so the build makes the runtime too. */
const NAMED_REALTIME = `import { useRecord } from '@ultimat3/realtime';
export function mount(): unknown {
  return useRecord('posts', 'p1');
}
`;

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'runtime-chunk-fixture' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('isRuntimeChunk', () => {
  test('is the runtime chunk the build emitted, and never an island named realtime', async () => {
    await Bun.write(join(ROOT, 'apps/web/app/realtime.island.tsx'), NAMED_REALTIME);
    const bundle = await buildIslands(ROOT);

    const [island] = bundle.chunks;
    expect(island?.url).toStartWith('/islands/realtime-');
    expect(isRuntimeChunk(island?.url ?? '')).toBe(false);
    expect(bundle.shared.filter((one) => isRuntimeChunk(one.url))).toHaveLength(1);
    expect(island?.imports.filter(isRuntimeChunk)).toHaveLength(1);
  });

  test('reads the file name under any base path, and nothing else', () => {
    expect(isRuntimeChunk('/islands/page-runtime.0a1b2c3d.js')).toBe(true);
    expect(isRuntimeChunk('/base/islands/page-runtime.0a1b2c3d.js')).toBe(true);
    expect(isRuntimeChunk('/islands/page-runtime-0a1b2c3d.js')).toBe(false); // an island's shape
    expect(isRuntimeChunk('/islands/chunk-0a1b2c3d.js')).toBe(false);
    expect(isRuntimeChunk('/islands/page-runtime.0a1b2c3d.js.map')).toBe(false);
    expect(isRuntimeChunk('page-runtime.0a1b2c3d.js')).toBe(false);
  });
});

/**
 * An app outside this checkout — inside it, the repo's tsconfig `paths` answer every
 * `@ultimat3/realtime` with the workspace's own, so no second copy could ever resolve — whose two
 * apps each install their own realtime: the workspace's, and one at another version.
 */
async function twoCopies(
  version: string,
): Promise<{ readonly root: string; readonly other: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-two-realtimes-'));
  await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'two-realtimes' }));
  const own = join(root, 'apps/web/node_modules/@ultimat3');
  await mkdir(own, { recursive: true });
  await symlink(join(import.meta.dir, '..', '..', 'realtime'), join(own, 'realtime'));
  const other = join(root, 'apps/other/node_modules/@ultimat3/realtime');
  await Bun.write(
    join(other, 'package.json'),
    JSON.stringify({
      name: '@ultimat3/realtime',
      version,
      type: 'module',
      exports: {
        '.': './src/index.ts',
        './page-runtime': './src/page-runtime.ts',
        './page-runtime-wait': './src/page-runtime-wait.ts',
      },
    }),
  );
  await Bun.write(
    join(other, 'src/index.ts'),
    'export function installRealtime(): void {}\nexport function useRecord(): void {}\n',
  );
  await Bun.write(
    join(other, 'src/page-runtime.ts'),
    'export function installPageRuntime(): void {}\n',
  );
  await Bun.write(
    join(other, 'src/page-runtime-wait.ts'),
    'export async function awaitPageRuntime(): Promise<void> {}\n',
  );
  for (const app of ['web', 'other']) {
    await Bun.write(join(root, `apps/${app}/app/${app}.island.tsx`), NAMED_REALTIME);
  }
  return { root, other };
}

describe('two realtime copies in one build', () => {
  // The concurrency audit: one runtime chunk per copy, and the first to install wins the page —
  // so an island of the other copy would call services of a shape it was not built against.
  test('at two versions, the build is refused, naming both copies', async () => {
    const { root, other } = await twoCopies('0.0.0-other');
    try {
      let caught: unknown;
      try {
        await buildIslands(root);
      } catch (error) {
        caught = error;
      }
      const cause = String((caught as { cause?: unknown } | undefined)?.cause ?? '');
      expect((caught as { code?: unknown } | undefined)?.code).toBe('X_BUILD_FAILED');
      expect(cause).toContain(other);
      expect(cause).toContain('0.0.0-other');
      expect(cause).toContain('lockstep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
