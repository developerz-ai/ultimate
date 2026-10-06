// Compiles an app tree's `apps/web/server.ts` with `binaryArgs` — the exact argv `x build --target
// binary` runs — and starts the executable from that tree, as the binary is documented to be run.
//
//   bun test packages/cli/e2e/binary-launch.e2e.test.ts
//
// What only a compiled binary can prove: it is a LAUNCHER for an app tree, importing the app's
// `app.config.ts` and `apps/*` at run time, and a standalone executable reads no `package.json` and
// no `tsconfig.json` at run time unless it was built to. Without them every package whose
// `exports` points below its root — every `@ultimat3/*`, `./src/index.ts` — is
// `Cannot find module '@ultimat3/core' from '<app>/app.config.ts'`, which is how the binary never
// answered `/healthz` on windows-latest. Linux failed identically; nothing there ran the artifact.
// And once it resolves, the framework must be ONE instance: the app's modules import `@ultimat3/*`
// from disk, so a copy bundled into the binary is a second registry the app never writes to.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and Bun.spawn take one already joined.
import { join } from 'node:path';
import { binaryArgs, binaryOutfile } from '../src/cmd-build';

const root = mkdtempSync(join(tmpdir(), 'ultimate-binary-launch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A package laid out as every `@ultimat3/*` is: the entry under `src/`, named by `exports`. */
await Bun.write(
  join(root, 'node_modules/@probe/lib/package.json'),
  JSON.stringify({ name: '@probe/lib', type: 'module', exports: { '.': './src/index.ts' } }),
);
await Bun.write(join(root, 'node_modules/@probe/lib/src/index.ts'), 'export const fromLib = 41;\n');
/**
 * A framework package holding process state, as every registry does: the app registers into it
 * from a module loaded off disk, and the bundled server must read the SAME instance back.
 */
await Bun.write(
  join(root, 'node_modules/@ultimat3/probe-registry/package.json'),
  JSON.stringify({
    name: '@ultimat3/probe-registry',
    type: 'module',
    exports: { '.': './src/index.ts' },
  }),
);
await Bun.write(
  join(root, 'node_modules/@ultimat3/probe-registry/src/index.ts'),
  'const names: string[] = [];\nexport const register = (name: string) => names.push(name);\nexport const registered = () => names.length;\n',
);
/** And the app's own alias, which only its `tsconfig.json` `paths` resolves. */
await Bun.write(
  join(root, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { paths: { '@probe-app/*': ['./packages/*/src'] } } }),
);
await Bun.write(join(root, 'packages/shared/src/index.ts'), 'export const fromAlias = 1;\n');
await Bun.write(
  join(root, 'app.config.ts'),
  [
    "import { fromLib } from '@probe/lib';",
    "import { fromAlias } from '@probe-app/shared';",
    "import { register } from '@ultimat3/probe-registry';",
    "register('app');",
    'export const answer = fromLib + fromAlias;',
    '',
  ].join('\n'),
);
// The launcher's own shape: the tree is the directory it is started in, read at run time.
await Bun.write(
  join(root, 'apps/web/server.ts'),
  [
    "import { join } from 'node:path';",
    "import { registered } from '@ultimat3/probe-registry';",
    "const { answer } = await import(join(process.cwd(), 'app.config.ts'));",
    "console.log('answer=' + answer + ' registered=' + registered());",
    '',
  ].join('\n'),
);

test('the compiled launcher resolves its app tree at run time, against ONE framework instance', async () => {
  const out = binaryOutfile(join(root, '.x', 'app'), undefined);
  // Bounded: a compile or a launcher that hangs is a failed test, never a hung worker.
  const build = Bun.spawnSync([...binaryArgs(root, out)], {
    cwd: root,
    stderr: 'pipe',
    timeout: 90_000,
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);

  const run = Bun.spawnSync([out], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
  expect(run.stderr.toString()).not.toContain('Cannot find');
  // `registered=1`: what the app put in the framework's registry is what the server reads back.
  // A bundled copy of the package answers 0 — two instances, the app's write in the other one.
  expect(run.stdout.toString().trim()).toBe('answer=42 registered=1');
  expect(run.exitCode).toBe(0);
}, 120_000);
