// The discovery behind an app's own `RuntimeOverrides`: `apps/<app>/runtime.ts` exports `runtime`,
// and both boots read the same file. Fixture directories per case, because `import()` caches by
// path and a rewritten file would answer with its first body.
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; fixtures are joined to this file's directory.
import { join } from 'node:path';
import { loadAppRuntime } from './app-runtime';

const FIXTURES = join(import.meta.dir, '..', '.app-runtime-fixture');

const fixture = async (name: string, files: Readonly<Record<string, string>>): Promise<string> => {
  const root = join(FIXTURES, name);
  await rm(root, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(root, path), contents);
  return root;
};

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true });
});

describe('loadAppRuntime', () => {
  test('the exported runtime is handed on as declared, middleware included', async () => {
    const root = await fixture('declared', {
      'apps/web/runtime.ts':
        'const stamp = async (ctx, next) => next();\n' +
        'export const runtime = { middleware: [stamp] };\n',
    });
    const runtime = await loadAppRuntime(root);
    expect(runtime?.middleware).toHaveLength(1);
    expect(typeof runtime?.middleware?.[0]).toBe('function');
  });

  test('no runtime.ts, or one exporting nothing of that name, is no override at all', async () => {
    expect(
      await loadAppRuntime(await fixture('absent', { 'apps/web/mcp.ts': '' })),
    ).toBeUndefined();
    const other = await fixture('other-export', {
      'apps/web/runtime.ts': 'export const middleware = [];\n',
    });
    expect(await loadAppRuntime(other)).toBeUndefined();
  });
});
