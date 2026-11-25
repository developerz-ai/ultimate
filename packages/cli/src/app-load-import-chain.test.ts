// An import that fails inside an installed package is reported at the APP module that pulled the
// package in, with the chain between them — a deployed app once refused every role over a finding
// that named a framework file and told its reader to `bun add` a package the framework declares.
// The load runs in a child process: Bun's resolver and the registries are per-process.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { devImportFindings } from './app-dev-imports';
import type { ChildLoader } from './app-load-child-fixture';
import { childLoad } from './app-load-child-fixture';
import { dependencyImports } from './app-load-import-chain';
import { exec } from './exec';
import type { Finding } from './output';
import { collapseFindings } from './output-findings';

let root = '';

const write = (path: string, text: string): Promise<number> => Bun.write(join(root, path), text);

/** An installed package, by hand: its manifest beside its files. */
const installed = async (
  name: string,
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  const dir = `node_modules/${name}`;
  await write(`${dir}/package.json`, JSON.stringify({ name, version: '1.0.0', ...manifest }));
  for (const [file, text] of Object.entries(files)) await write(`${dir}/${file}`, text);
};

/** The tool's load, or a background role's. */
const load = (loader?: ChildLoader): Promise<readonly Finding[]> => childLoad(root, loader);

/** The incident's shape: `@ultimat3/cli`'s barrel reaching `@ultimat3/testing`, which is pruned. */
const prunedFramework = (): Promise<void> =>
  installed(
    '@ultimat3/cli',
    { module: 'src/index.ts', dependencies: { '@ultimat3/testing': '1.0.0' } },
    {
      'src/index.ts': "export { buildIslands } from './verify';\n",
      'src/verify.ts': "export { shards as buildIslands } from './test-shards';\n",
      'src/test-shards.ts': "import { x } from '@ultimat3/testing';\nexport const shards = x;\n",
    },
  );

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-app-load-chain-'));
  await write('app.config.ts', "export const config = { name: 'fixture' };\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// Each test is its own app: what one left behind would be another's finding.
afterEach(() => rmSync(join(root, 'apps'), { recursive: true, force: true }));

describe('an import that fails inside an installed package', () => {
  test('the framework barrel: at the app module, its chain, and the edit to that module', async () => {
    await prunedFramework();
    await write(
      'apps/web/app/board/board.fixture.ts',
      "import { buildIslands } from '@ultimat3/cli';\nexport const island = buildIslands;\n",
    );
    // Reaches the barrel only through the fixture: the same defect, so the same finding.
    await write('apps/web/app/board/other.ts', "export { island } from './board.fixture';\n");
    const findings = collapseFindings(await load());
    expect(findings.map((one) => [one.code, one.at])).toEqual([
      ['X_APP_IMPORT_UNRESOLVED', 'apps/web/app/board/board.fixture.ts'],
    ]);
    const [finding] = findings;
    expect(finding?.meta?.['count']).toBe(2);
    expect(finding?.cause).toBe(
      'apps/web/app/board/board.fixture.ts imports "@ultimat3/cli", a development entry no role may load, and that reaches @ultimat3/testing, which is not installed: apps/web/app/board/board.fixture.ts → @ultimat3/cli/src/index.ts → @ultimat3/cli/src/verify.ts → @ultimat3/cli/src/test-shards.ts → @ultimat3/testing',
    );
    expect(finding?.meta?.['chain']).toEqual([
      'apps/web/app/board/board.fixture.ts',
      'node_modules/@ultimat3/cli/src/index.ts',
      'node_modules/@ultimat3/cli/src/verify.ts',
      'node_modules/@ultimat3/cli/src/test-shards.ts',
    ]);
    expect(finding?.fix).toStartWith(
      'grep -nF -- @ultimat3/cli apps/web/app/board/board.fixture.ts   # ',
    );
    expect(finding?.fix).toContain('apps/web/test/');
    const edit = await exec(['sh', '-c', finding?.fix ?? ''], { cwd: root });
    expect([edit.code, edit.stdout]).toEqual([
      0,
      "1:import { buildIslands } from '@ultimat3/cli';\n",
    ]);
    await write('apps/web/app/board/board.fixture.ts', 'export const island = 1;\n');
    expect(await load()).toEqual([]);
  });

  test("a declared dependency missing from the install is bun install, never the app's own bun add", async () => {
    await installed(
      'outer-pkg',
      { main: 'index.js', dependencies: { 'inner-pkg': '1.0.0' } },
      { 'index.js': "export { x } from 'inner-pkg';\n" },
    );
    await write('apps/web/app/outer/a.ts', "export { x } from 'outer-pkg';\n");
    const [finding, ...rest] = collapseFindings(await load());
    expect(rest).toEqual([]);
    expect(finding?.at).toBe('apps/web/app/outer/a.ts');
    expect(finding?.cause).toBe(
      'apps/web/app/outer/a.ts imports "outer-pkg", and that reaches inner-pkg, which is not installed: apps/web/app/outer/a.ts → outer-pkg/index.js → inner-pkg',
    );
    expect(finding?.fix).toStartWith('bun install --frozen-lockfile   # ');
  });

  test('a peer the app owes is still bun add', async () => {
    await installed(
      'peer-pkg',
      { main: 'index.js', peerDependencies: { 'host-pkg': '1.0.0' } },
      { 'index.js': "export { x } from 'host-pkg';\n" },
    );
    await write('apps/web/app/peer/a.ts', "export { x } from 'peer-pkg';\n");
    const [finding] = await load();
    expect(finding?.at).toBe('apps/web/app/peer/a.ts');
    expect(finding?.fix).toBe('bun add host-pkg');
  });

  // A role's load asks `include` per module, so it imports them one by one: the other scan.
  test('a role load, which imports serially, says the same', async () => {
    await prunedFramework();
    await write('apps/web/app/board/a.ts', "export { buildIslands } from '@ultimat3/cli';\n");
    const [finding] = await load({ file: 'role-load.ts', name: 'scanBackground' });
    expect(finding?.at).toBe('apps/web/app/board/a.ts');
    expect(finding?.meta?.['chain']).toEqual([
      'apps/web/app/board/a.ts',
      'node_modules/@ultimat3/cli/src/index.ts',
      'node_modules/@ultimat3/cli/src/verify.ts',
      'node_modules/@ultimat3/cli/src/test-shards.ts',
    ]);
    expect(finding?.fix).toStartWith('grep -nF -- @ultimat3/cli apps/web/app/board/a.ts   # ');
  });

  test('two app modules that each import the package are two findings, one edit each', async () => {
    await prunedFramework();
    await write('apps/web/app/two/a.ts', "export { buildIslands as a } from '@ultimat3/cli';\n");
    await write('apps/web/app/two/b.ts', "export { buildIslands as b } from '@ultimat3/cli';\n");
    const findings = collapseFindings(await load());
    expect(findings.map((one) => one.at)).toEqual([
      'apps/web/app/two/a.ts',
      'apps/web/app/two/b.ts',
    ]);
  });

  test('a helper outside the scan: the edge into it, the one the gate names', async () => {
    await prunedFramework();
    await write('apps/web/test/kit.ts', "export { buildIslands } from '@ultimat3/cli';\n");
    await write('apps/web/app/kit/a.ts', "export { buildIslands } from '../../test/kit';\n");
    await write('apps/web/app/kit/b.ts', "export { buildIslands } from '../../test/kit';\n");
    await write('apps/web/app/kit/c.ts', "export { buildIslands } from './b';\n");
    const boot = collapseFindings(await load());
    const gate = await devImportFindings(root);
    expect(boot.map((one) => [one.at, one.fix])).toEqual(gate.map((one) => [one.at, one.fix]));
    expect(boot.map((one) => one.at)).toEqual(['apps/web/app/kit/a.ts', 'apps/web/app/kit/b.ts']);
    expect(boot[0]?.fix).toStartWith('grep -nF -- ../../test/kit apps/web/app/kit/a.ts   # ');
    expect(boot[0]?.cause).toBe(
      'apps/web/app/kit/a.ts imports "../../test/kit", which brings in "@ultimat3/cli", a development entry no role may load, and that reaches @ultimat3/testing, which is not installed: apps/web/app/kit/a.ts → apps/web/test/kit.ts → @ultimat3/cli/src/index.ts → @ultimat3/cli/src/verify.ts → @ultimat3/cli/src/test-shards.ts → @ultimat3/testing',
    );
    expect(boot[0]?.meta?.['chain']).toEqual([
      'apps/web/app/kit/a.ts',
      'apps/web/test/kit.ts',
      'node_modules/@ultimat3/cli/src/index.ts',
      'node_modules/@ultimat3/cli/src/verify.ts',
      'node_modules/@ultimat3/cli/src/test-shards.ts',
    ]);
  });

  test('a chain no static import spells still names the app module, never the package file', async () => {
    await installed(
      'lazy-pkg',
      { main: 'index.js', dependencies: { 'gone-pkg': '1.0.0' } },
      {
        'index.js': "const at = './part.js';\nexport const { x } = await import(at);\n",
        'part.js': "export { x } from 'gone-pkg';\n",
      },
    );
    await write('apps/web/app/lazy/a.ts', "export { x } from 'lazy-pkg';\n");
    const [finding] = await load();
    expect(finding?.at).toBe('apps/web/app/lazy/a.ts');
    expect(finding?.cause).toContain('node_modules/lazy-pkg/part.js');
    // No static import spells the way there, so there is no chain to name.
    expect(finding?.meta).toEqual({ specifier: 'gone-pkg' });
    expect(finding?.fix).toStartWith('bun install --frozen-lockfile   # ');
  });
});

// In this process, over a failure handed in: what the load does with one, without the load.
describe('explaining a failure', () => {
  const failure = (specifier: string, referrer: string) => ({
    code: 'ERR_MODULE_NOT_FOUND',
    specifier,
    referrer: join(root, referrer),
  });

  test('the chain starts at the last app module, whichever one was being imported', async () => {
    await prunedFramework();
    await write('apps/web/app/x/kit.ts', "export { buildIslands } from '@ultimat3/cli';\n");
    await write('apps/web/app/x/page.ts', "export { buildIslands } from './kit';\n");
    const explain = dependencyImports(root);
    const error = failure('@ultimat3/testing', 'node_modules/@ultimat3/cli/src/test-shards.ts');
    const finding = await explain(error, 'apps/web/app/x/page.ts');
    expect(finding.at).toBe('apps/web/app/x/kit.ts');
    expect(finding.meta?.['chain']).toEqual([
      'apps/web/app/x/kit.ts',
      'node_modules/@ultimat3/cli/src/index.ts',
      'node_modules/@ultimat3/cli/src/verify.ts',
      'node_modules/@ultimat3/cli/src/test-shards.ts',
    ]);
    expect(await explain(error, 'apps/web/app/x/kit.ts')).toEqual(finding);
  });

  test('a module the walk does not reach leaves the one being imported', async () => {
    await installed('far-pkg', { main: 'index.js' }, { 'index.js': '' });
    await write('apps/web/app/x/a.ts', 'export const a = 1;\n');
    const error = failure('gone-pkg', 'node_modules/far-pkg/index.js');
    expect(await dependencyImports(root)(error, 'apps/web/app/x/a.ts')).toEqual({
      code: 'X_APP_IMPORT_UNRESOLVED',
      cause:
        'importing apps/web/app/x/a.ts: node_modules/far-pkg/index.js imports gone-pkg, which is not installed',
      fix: 'bun add gone-pkg',
      at: 'apps/web/app/x/a.ts',
      meta: { specifier: 'gone-pkg' },
    });
  });

  test('any other failure is reported at the module, as itself', async () => {
    const finding = await dependencyImports(root)(new TypeError('boom'), 'apps/web/app/x/a.ts');
    expect(finding.code).not.toBe('X_APP_IMPORT_UNRESOLVED');
    expect([finding.at, finding.cause]).toEqual([
      'apps/web/app/x/a.ts',
      expect.stringContaining('boom'),
    ]);
  });
});
