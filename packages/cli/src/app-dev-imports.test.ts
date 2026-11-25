// What a role evaluates must reach no development entry: the gate says so before a deployed image
// does. Fixture trees on disk, because the check is of the files the boot scan imports.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { BOUNDARY_CODES } from './app-boundaries';
import { devImportFindings, devImportWarnings } from './app-dev-imports';
import { VERIFY_STEPS } from './cmd-verify';
import { exec } from './exec';

let root = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-app-dev-imports-'));
  await write('app.config.ts', "export const config = { name: 'fixture' };\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text: string): Promise<number> => Bun.write(join(root, path), text);

describe('a module the boot scan imports', () => {
  test.each([
    [
      "import { buildIslands } from '@ultimat3/cli';\nexport const x = buildIslands;\n",
      '@ultimat3/cli',
    ],
    ["import '@ultimat3/cli';\n", '@ultimat3/cli'],
    ["export { buildIslands } from '@ultimat3/cli';\n", '@ultimat3/cli'],
    [
      "import { expect } from '@ultimat3/testing';\nexport const x = expect;\n",
      '@ultimat3/testing',
    ],
    ["import { afterAll } from 'bun:test';\nexport const x = afterAll;\n", 'bun:test'],
  ])('%j is refused', async (source, specifier) => {
    await write('apps/web/app/board/board.fixture.ts', source);
    expect(await devImportFindings(root)).toEqual([
      {
        code: 'X_BOUNDARY_DEV_IMPORT',
        cause: `the boot scan imports apps/web/app/board/board.fixture.ts, and it imports "${specifier}", a development entry: an image that leaves the test packages out boots no role`,
        fix: `grep -nF -- ${specifier} apps/web/app/board/board.fixture.ts   # test support moves to apps/web/test/, which no role loads; a module a role needs drops this import`,
        docs: 'https://github.com/developerz-ai/ultimate/wiki/Error-Codes',
        at: 'apps/web/app/board/board.fixture.ts',
        meta: { specifier, chain: ['apps/web/app/board/board.fixture.ts'] },
      },
    ]);
  });

  test.each([
    ['a type', "import type { Finding } from '@ultimat3/cli';\nexport type F = Finding;\n"],
    ['an inline type', "import { type Finding } from '@ultimat3/cli';\nexport type F = Finding;\n"],
    [
      'the serve entry',
      "import { runRole } from '@ultimat3/cli/serve';\nexport const x = runRole;\n",
    ],
    ['a lazy import', "export const x = () => import('@ultimat3/cli');\n"],
    [
      'a name that only starts alike',
      "import { x } from '@ultimat3/testing-kit';\nexport { x };\n",
    ],
    ['a comment', "// import { x } from '@ultimat3/cli';\nexport const x = 1;\n"],
  ])('%s is not', async (_what, source) => {
    await write('apps/web/app/board/a.ts', source);
    expect(await devImportFindings(root)).toEqual([]);
  });

  test.each([
    'apps/web/app/board/a.test.ts',
    'apps/web/app/board/a.island.states.ts',
    'apps/web/prerender.ts',
    'apps/web/server.ts',
    'apps/web/exercise.ts',
    'apps/web/test/kit.ts',
    'apps/web/e2e/kit.ts',
    'guards/a.ts',
  ])('%s is not one the scan imports', async (path) => {
    await write(path, "import { x } from '@ultimat3/cli';\nexport { x };\n");
    expect(await devImportFindings(root)).toEqual([]);
  });

  test('a helper outside the scan is found at the scanned module that reaches it, with the chain', async () => {
    await write(
      'apps/web/test/kit.ts',
      "import { migratedDatabase } from '@ultimat3/cli';\nexport const kit = migratedDatabase;\n",
    );
    await write('apps/web/shared/mid.ts', "export { kit } from '../test/kit';\n");
    await write('apps/web/app/board/a.ts', "export { kit } from '../../shared/mid';\n");
    const findings = await devImportFindings(root);
    expect(findings.map((one) => [one.at, one.meta?.['chain']])).toEqual([
      ['apps/web/shared/mid.ts', ['apps/web/shared/mid.ts', 'apps/web/test/kit.ts']],
    ]);
    expect(findings[0]?.cause).toStartWith(
      'the boot scan imports apps/web/test/kit.ts (apps/web/shared/mid.ts → apps/web/test/kit.ts), and it imports "@ultimat3/cli"',
    );
    // Moving a helper that is already outside the scan clears nothing: the edge into it is the cut.
    expect(findings[0]?.fix).toStartWith('grep -nF -- ../test/kit apps/web/shared/mid.ts   # ');
  });

  test('two scanned modules sharing one helper are two cuts, and making both clears it', async () => {
    await write('apps/web/test/deep.ts', "import '@ultimat3/cli';\nexport const deep = 1;\n");
    await write('apps/web/test/mid.ts', "export { deep } from './deep';\n");
    await write('apps/web/test/kit.ts', "export { deep } from './mid';\n");
    await write('apps/web/app/a.ts', "export { deep } from '../test/kit';\n");
    await write('apps/web/app/b.ts', "export { deep } from '../test/kit';\n");
    // Straight to the deeper one: another edge of a module that already has a cut.
    await write(
      'apps/web/app/c.ts',
      "import '../test/kit';\nexport { deep } from '../test/deep';\n",
    );
    const viaKit = ['apps/web/test/kit.ts', 'apps/web/test/mid.ts', 'apps/web/test/deep.ts'];
    expect((await devImportFindings(root)).map((one) => [one.at, one.meta?.['chain']])).toEqual([
      ['apps/web/app/a.ts', ['apps/web/app/a.ts', ...viaKit]],
      ['apps/web/app/b.ts', ['apps/web/app/b.ts', ...viaKit]],
      ['apps/web/app/c.ts', ['apps/web/app/c.ts', 'apps/web/test/deep.ts']],
      ['apps/web/app/c.ts', ['apps/web/app/c.ts', ...viaKit]],
    ]);
    await write('apps/web/app/a.ts', 'export {};\n');
    expect((await devImportFindings(root)).map((one) => one.at)).toEqual([
      'apps/web/app/b.ts',
      'apps/web/app/c.ts',
      'apps/web/app/c.ts',
    ]);
    await write('apps/web/app/b.ts', 'export {};\n');
    await write('apps/web/app/c.ts', 'export {};\n');
    expect(await devImportFindings(root)).toEqual([]);
  });

  test('helpers that import each other end, and one import written twice is one finding', async () => {
    await write(
      'apps/web/test/a.ts',
      "import './b';\nimport '@ultimat3/cli';\nimport '@ultimat3/cli';\n",
    );
    await write('apps/web/test/b.ts', "import './a';\n");
    await write('apps/web/app/x.ts', "import '../test/b';\n");
    expect((await devImportFindings(root)).map((one) => one.meta?.['chain'])).toEqual([
      ['apps/web/app/x.ts', 'apps/web/test/b.ts', 'apps/web/test/a.ts'],
    ]);
  });

  // Executed, because the comment is where an unescaped name ends the line it sits on.
  test.each([
    ['apps/w\ntouch pwned\n#/app/a.ts', "import '@ultimat3/cli';\n"],
    ['packages/p\ntouch pwned\n#/src/a.ts', "import '@ultimat3/cli';\n"],
  ])('a workspace name holding a newline runs nothing: %j', async (path, source) => {
    await write(path, source);
    const [finding] = await devImportFindings(root);
    expect(finding?.at).toBe(path);
    const shown = await exec(['sh', '-c', finding?.fix ?? ''], { cwd: root });
    expect([shown.code, shown.stdout]).toEqual([0, "1:import '@ultimat3/cli';\n"]);
    expect(await Bun.file(join(root, 'pwned')).exists()).toBe(false);
    expect(finding?.fix.split('   # ')[1]).not.toContain('\n');
  });

  test('an installed package is not walked, and a workspace package is', async () => {
    await write('node_modules/vendor/package.json', '{"name":"vendor","main":"index.js"}');
    await write(
      'node_modules/vendor/index.js',
      "import '@ultimat3/testing';\nexport const x = 1;\n",
    );
    await write('packages/kit/src/index.ts', "import { x } from 'vendor';\nexport { x };\n");
    expect(await devImportFindings(root)).toEqual([]);
    await write('packages/kit/src/fake.ts', "import '@ultimat3/testing';\n");
    expect((await devImportFindings(root)).map((one) => one.fix)).toEqual([
      'grep -nF -- @ultimat3/testing packages/kit/src/fake.ts   # test support moves to packages/kit/test/, which no role loads; a module a role needs drops this import',
    ]);
  });

  test('a tree that is no app has no boot scan to answer for', async () => {
    rmSync(join(root, 'app.config.ts'));
    await write('packages/kit/src/fake.ts', "import '@ultimat3/testing';\n");
    expect(await devImportFindings(root)).toEqual([]);
  });

  test('the printed line shows the import to edit', async () => {
    await write('apps/web/app/a.ts', "export const y = 1;\nimport '@ultimat3/cli';\n");
    const [finding] = await devImportFindings(root);
    const shown = await exec(['sh', '-c', finding?.fix ?? ''], { cwd: root });
    expect([shown.code, shown.stdout]).toEqual([0, "2:import '@ultimat3/cli';\n"]);
  });
});

describe('the gate', () => {
  test('carries it as a warning: an app that passed yesterday passes today', async () => {
    await write('apps/web/app/a.ts', "import '@ultimat3/cli';\n");
    const [line, ...rest] = await devImportWarnings(root);
    expect(rest).toEqual([]);
    expect(line).toStartWith('X_BOUNDARY_DEV_IMPORT the boot scan imports apps/web/app/a.ts');
    expect(line).toContain(' — fix: grep -nF -- @ultimat3/cli apps/web/app/a.ts');
  });

  test('the boundaries step lists it and stays green', async () => {
    await write('apps/web/app/a.ts', "import '@ultimat3/cli';\n");
    const step = VERIFY_STEPS.find((one) => one.name === 'boundaries');
    const outcome = await step?.run({ root, runner: exec });
    expect(outcome?.ok).toBe(true);
    expect(outcome?.warnings).toEqual(expect.arrayContaining([...(await devImportWarnings(root))]));
    await write('apps/web/app/a.ts', 'export const a = 1;\n');
    const cleared = (await step?.run({ root, runner: exec }))?.warnings ?? [];
    expect(cleared.filter((line) => line.startsWith('X_BOUNDARY_DEV_IMPORT'))).toEqual([]);
  });

  test('is one of the boundary codes', () => {
    expect(BOUNDARY_CODES).toContain('X_BOUNDARY_DEV_IMPORT');
  });
});
