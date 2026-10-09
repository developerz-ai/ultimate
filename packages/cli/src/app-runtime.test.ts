// The discovery behind an app's own `RuntimeOverrides`: `apps/<app>/runtime.ts` exports `runtime`,
// and both boots read the same file. Fixture directories per case, because `import()` caches by
// path and a rewritten file would answer with its first body.
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; fixtures are joined to this file's directory.
import { join } from 'node:path';
import { loadAppRuntime } from './app-runtime';
import { processRoot } from './process-root-fixture';

const FIXTURES = processRoot(join(import.meta.dir, '..', '.app-runtime-fixture'));

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

  // The production boot: `runRole` reads `runtime.ts` FIRST, before anything on `@ultimat3/cli/serve`'s
  // static graph has imported `@ultimat3/render/server`, so a component that file reaches was
  // compiled by Bun's own loader — `jsx: "preserve"` → `React.createElement` — and cached that way
  // for every page that imports it later (notificado.co, 27.2.0: `React is not defined`). Its own
  // process, because this test process's preload has the loader installed long before any import.
  test('a component runtime.ts imports is compiled by the framework JSX loader, not React', async () => {
    const root = await fixture('jsx', {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' },
      }),
      'apps/web/shared/badge.tsx': 'export const Badge = () => <b>ok</b>;\n',
      'apps/web/runtime.ts':
        "import { Badge } from './shared/badge';\nexport const runtime = { badge: Badge };\n",
    });
    const script = `const { loadAppRuntime } = await import(${JSON.stringify(join(import.meta.dir, 'app-runtime.ts'))});
const runtime = await loadAppRuntime(process.cwd());
try { const node = runtime.badge(); console.log(typeof node === 'object' && node !== null ? 'node' : typeof node); }
catch (error) { console.log(String(error)); }`;
    const child = Bun.spawn(['bun', '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect([code, out.trim(), err.includes('React') ? err : '']).toEqual([0, 'node', '']);
  }, 30_000);
});
