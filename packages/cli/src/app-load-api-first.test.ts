// The API index is the first module the scan evaluates, so a path derived at another module's top
// level is derived under the app's declared `pathStyle` — the notificado.co 22.6.0 adoption, where
// `apps/admin/**` sorted before `apps/web/api/index.ts` and an admin sign-out form captured the
// default style's `/api/outs/sign` while the server served `/api/sign-out`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a recursive delete or a symlink.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { appModulePaths } from './app-load';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const INDEX = `import { action, defineApi, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
export const signOut = action({
  input: t.object({}),
  output: t.object({ ok: t.boolean }),
  policy: allow('session:delete'),
  handle: () => ({ ok: true }),
});
export const api = defineApi({ actions: { signOut }, http: { pathStyle: 'readable' } });
`;

/** Sorts before `apps/web/**`, and captures its form target the way a page module does. */
const ADMIN_VIEWS = `import { derivePath } from '@ultimat3/action';
export const SIGN_OUT_PATH = derivePath('signOut').path;
`;

/** A fixture app that resolves `@ultimat3/*` through the CLI's own workspace links. */
async function fixtureApp(prefix: string): Promise<string> {
  root = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(import.meta.dir, '..', 'node_modules'), join(root, 'node_modules'));
  await Bun.write(join(root, 'apps/web/api/index.ts'), INDEX);
  await Bun.write(join(root, 'apps/admin/app/admin/views.ts'), ADMIN_VIEWS);
  return root;
}

describe('unit · loadApp evaluates the API declaration before any other module', () => {
  test('the API index is the first path, the rest keep their sorted order', async () => {
    const dir = await fixtureApp('x-app-load-api-first-');
    const paths = (await appModulePaths(dir)).map((path) => path.slice(dir.length + 1));
    expect(paths).toEqual(['apps/web/api/index.ts', 'apps/admin/app/admin/views.ts']);
  });

  // In a child process: the scan registers into this process's action registry and style, which
  // every other test file in a shared `bun test` run reads.
  test('a module-level derivePath in apps/admin captures the declared style', async () => {
    const dir = await fixtureApp('x-app-load-api-style-');
    const probe = `const { loadApp } = await import(${JSON.stringify(`${import.meta.dir}/app-load.ts`)});
const app = await loadApp(${JSON.stringify(dir)});
const views = await import(${JSON.stringify(join(dir, 'apps/admin/app/admin/views.ts'))});
console.log(JSON.stringify({ findings: app.findings.map((f) => f.code), path: views.SIGN_OUT_PATH }));`;
    const child = Bun.spawn(['bun', '-e', probe], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    expect({ exit: await child.exited, err }).toEqual({ exit: 0, err: '' });
    expect(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')).toEqual({
      findings: [],
      path: '/api/sign-out',
    });
  });
});
