// A generated file that imports a sibling workspace leaves the manifest of the workspace it landed
// in declaring that edge — what `package-shape` demands of the author (X_WORKSPACE_DEP_UNDECLARED).
// `x g admin:page` wrote `useT` from `@<app>/i18n` into `apps/admin` and left the scaffold's own
// second `bin/check` red on the generator's output.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, so a throwaway app root's lifetime is node:fs's.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { declareGeneratedImports } from './generated-imports';
import { checkWorkspaceDependencies } from './workspace-graph';

const PAGE = 'apps/admin/app/admin/pages/ops.tsx';

let root = '';

const write = (path: string, contents: string): Promise<number> =>
  Bun.write(join(root, path), contents);

const manifest = (name: string, dependencies: Record<string, string> = {}): string =>
  `${JSON.stringify({ name, version: '0.0.0', private: true, dependencies }, null, 2)}\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-generated-imports-'));
  await write(
    'package.json',
    JSON.stringify({ name: 'app', workspaces: ['apps/*', 'packages/*'] }),
  );
  await write('apps/admin/package.json', manifest('@app/admin', { '@app/db': '0.0.0' }));
  await write('packages/db/package.json', manifest('@app/db'));
  await write('packages/i18n/package.json', manifest('@app/i18n'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('unit · a generated import of a sibling workspace is declared where it landed', () => {
  test('the admin page that imports the app catalog leaves apps/admin declaring it', async () => {
    await write(PAGE, "import { useT } from '@app/i18n';\nexport const page = useT;\n");
    expect((await checkWorkspaceDependencies(root)).map((finding) => finding.code)).toEqual([
      'X_WORKSPACE_DEP_UNDECLARED',
    ]);

    expect(await declareGeneratedImports(root, [PAGE])).toEqual(['apps/admin/package.json']);

    expect(await checkWorkspaceDependencies(root)).toEqual([]);
    const after = (await Bun.file(join(root, 'apps/admin/package.json')).json()) as {
      dependencies: Record<string, string>;
    };
    expect(after.dependencies).toEqual({ '@app/db': '0.0.0', '@app/i18n': '0.0.0' });
  });

  test('an edge already declared, a registry package and a test file edit nothing', async () => {
    await write(PAGE, "import { db } from '@app/db';\nimport { t } from '@ultimat3/i18n';\n");
    await write(
      'apps/admin/app/admin/pages/ops.test.ts',
      "import { useT } from '@app/i18n';\nexport const page = useT;\n",
    );
    expect(
      await declareGeneratedImports(root, [PAGE, 'apps/admin/app/admin/pages/ops.test.ts']),
    ).toEqual([]);
    expect(await Bun.file(join(root, 'apps/admin/package.json')).text()).toBe(
      manifest('@app/admin', { '@app/db': '0.0.0' }),
    );
  });

  test('two files needing two edges rewrite the one manifest once, holding both', async () => {
    await write(PAGE, "import { useT } from '@app/i18n';\nexport const page = useT;\n");
    await write('packages/ui/package.json', manifest('@app/ui'));
    await write('apps/admin/app/admin/pages/two.tsx', "export { Button } from '@app/ui';\n");
    expect(
      await declareGeneratedImports(root, [PAGE, 'apps/admin/app/admin/pages/two.tsx']),
    ).toEqual(['apps/admin/package.json']);
    expect(await checkWorkspaceDependencies(root)).toEqual([]);
  });
});
