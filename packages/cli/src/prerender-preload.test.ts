// `x build --target static` preloads the render loader, so a `prerender.ts` whose own graph
// reaches a `.tsx` (a module importing `@ultimat3/ui`) is compiled by it and not by Bun's JSX.

import { expect, test } from 'bun:test';
// why: Bun has no temp-directory API; `node:fs` owns the throwaway tree.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only `node:os` answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { PRERENDER_PRELOAD, staticArgs } from './cmd-build';
// Loaded here as well, so the coverage run holds a record of it: the child processes below run it
// where `bun test --coverage` cannot see. Idempotent — the render loader installs once.
import './prerender-preload';
// Loaded here as well, so the coverage run holds a record of it: the child processes below run it
// where `bun test --coverage` cannot see. Idempotent — the render loader installs once.
import './prerender-preload';

test('the static build runs the app script with the render loader preloaded', () => {
  const args = staticArgs('/app', '/app/.x/static');
  expect(args.slice(0, 4)).toEqual(['bun', 'run', '--preload', PRERENDER_PRELOAD]);
  expect(args.at(-3)).toBe('/app/apps/web/prerender.ts');
});

test('a script that statically imports a .tsx evaluates under the preload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prerender-preload-'));
  try {
    // The render loader's `h` is what the compiled `.tsx` calls; without the loader Bun compiles
    // it against the tsconfig's jsxImportSource and the import fails before the script runs.
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'solid-js' } }),
    );
    writeFileSync(join(dir, 'view.tsx'), 'export const view = () => <p>ok</p>;\n');
    writeFileSync(
      join(dir, 'main.ts'),
      "import { view } from './view';\nconsole.log(typeof view);\n",
    );
    const run = (preload: boolean) =>
      Bun.spawnSync(
        ['bun', 'run', ...(preload ? ['--preload', PRERENDER_PRELOAD] : []), join(dir, 'main.ts')],
        { cwd: dir, timeout: 60_000 },
      );
    const withLoader = run(true);
    expect([withLoader.exitCode, withLoader.stdout.toString().trim()]).toEqual([0, 'function']);
    expect(run(false).exitCode).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
