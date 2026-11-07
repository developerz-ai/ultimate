// D8: `packages/domain/src/index.ts` importing `apps/web/app/post/repo` kept `boundaries` green,
// because no rule read `packages/` at all. A shared package silently depending on one app.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { BOUNDARY_CODES } from './app-boundaries';
import { appBoundaryFindings } from './boundary-findings';
import {
  packageBoundaryFindings,
  packageToAppFindings,
  readPackageSources,
} from './package-boundaries';
import { FIXTURE_APP, scaffoldFixture } from './scaffold-fixture';
import { workspaceRoot } from './scaffold-typecheck-fixture';

const WORKSPACES = new Map([
  ['@acme/web', 'apps/web'],
  ['@acme/admin', 'apps/admin'],
]);
const FROM = 'packages/domain/src/index.ts';

const check = (source: string, path = FROM) => packageToAppFindings([{ path, source }], WORKSPACES);

describe('unit · a package may not import an app', () => {
  test('the code is one of BOUNDARY_CODES', () => {
    expect(BOUNDARY_CODES).toContain('X_BOUNDARY_PACKAGE_TO_APP');
  });

  test.each([
    ['relative', "import { list } from '../../../apps/web/app/post/repo';\nlist();\n"],
    ['from the root', "import { list } from 'apps/web/app/post/repo';\nlist();\n"],
    ['by workspace name', "import { list } from '@acme/web/app/post/repo';\nlist();\n"],
    ['another workspace', "import { a } from '@acme/admin/app/admin/admin';\na();\n"],
    ['for its effects', "import '../../../apps/web/app/post/repo';\n"],
    ['dynamically', "export const load = () => import('../../../apps/web/app/post/repo');\n"],
    ['a re-export', "export { list } from '../../../apps/web/app/post/repo';\n"],
  ])('%s is refused, at the file, naming the module', (_name, source) => {
    const [finding, ...rest] = check(source);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_BOUNDARY_PACKAGE_TO_APP');
    expect(finding?.at).toBe(FROM);
    expect(`${finding?.cause}${finding?.fix}`).toMatch(/apps\/(web|admin)/);
    expect(finding?.fix).toStartWith('x verify --only boundaries');
  });

  test.each([
    ['import type', "import type { Post } from '../../../apps/web/app/post/repo';\n"],
    ['export type', "export type { Post } from '@acme/web/app/post/repo';\n"],
    ['package to package, relative', "import { a } from '../../core/src/a';\na();\n"],
    ['package to package, by name', "import { a } from '@acme/core';\na();\n"],
    ['a framework package', "import { t } from '@ultimat3/schema';\nt();\n"],
    ['a name that only starts like one', "import { a } from '@acme/web-kit/a';\na();\n"],
    ['a directory named apps inside the package', "import { a } from '../apps/a';\na();\n"],
  ])('%s passes', (_name, source) => {
    expect(check(source)).toEqual([]);
  });

  test('a hostile path never reaches the fix unsafely', () => {
    const [finding] = check("import '../../../apps/web/a\\nb';\n", 'packages/a/src/x.ts');
    expect(finding?.code).toBe('X_BOUNDARY_PACKAGE_TO_APP');
    expect(finding?.fix.split('\n').length ?? 0).toBeLessThanOrEqual(1);
  });
});

describe('unit · the db package reading an entity is the one generated exception', () => {
  const HANDLE = 'packages/db/src/client.ts';

  test('packages/db/src/ may import an entity module, the shape x g entity and x new write', () => {
    const source = "import { post } from '@acme/web/app/post/entity';\npost;\n";
    expect(check(source, HANDLE)).toEqual([]);
    expect(check(source, 'packages/db/src/schema.ts')).toEqual([]);
    const sibling = "import { line } from '@acme/web/app/post/entity-line';\nline;\n";
    expect(check(sibling, HANDLE)).toEqual([]);
  });

  // A slice nests (`app/runs/canary/`) as any feature directory does; its entity is the same
  // generated-handle entry, never a finding the app can only clear by flattening the slice.
  test('an entity in a nested slice is the same exception, and its repo still is not', () => {
    const nested = "import { canary } from '@acme/web/app/runs/canary/entity';\ncanary;\n";
    expect(check(nested, HANDLE)).toEqual([]);
    const sibling = "import { probe } from '@acme/web/app/runs/canary/entity-probe';\nprobe;\n";
    expect(check(sibling, HANDLE)).toEqual([]);
    const repo = "import { list } from '@acme/web/app/runs/canary/repo';\nlist();\n";
    expect(check(repo, HANDLE).map((one) => one.code)).toEqual(['X_BOUNDARY_PACKAGE_TO_APP']);
    const surfaceRoot = "import { x } from '@acme/web/app/entity';\nx;\n";
    expect(check(surfaceRoot, HANDLE).map((one) => one.code)).toEqual([
      'X_BOUNDARY_PACKAGE_TO_APP',
    ]);
  });

  test('and nothing else from an app, and no other package', () => {
    const repo = "import { list } from '@acme/web/app/post/repo';\nlist();\n";
    expect(check(repo, HANDLE).map((one) => one.code)).toEqual(['X_BOUNDARY_PACKAGE_TO_APP']);
    const entity = "import { post } from '@acme/web/app/post/entity';\npost;\n";
    expect(check(entity).map((one) => one.code)).toEqual(['X_BOUNDARY_PACKAGE_TO_APP']);
  });

  test('every generator over x new leaves no finding: the rule refuses no generated app', () => {
    const files = scaffoldFixture().flatMap((file) =>
      typeof file.contents === 'string' &&
      /^packages\/.*\.tsx?$/.test(file.path) &&
      !file.path.includes('.test.')
        ? [{ path: file.path, source: file.contents }]
        : [],
    );
    expect(files.length).toBeGreaterThan(0);
    expect(
      packageToAppFindings(
        files,
        new Map([
          [`@${FIXTURE_APP}/web`, 'apps/web'],
          [`@${FIXTURE_APP}/admin`, 'apps/admin'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('unit · the disk half', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const app = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'x-package-boundaries-'));
    roots.push(root);
    await Bun.write(join(root, 'apps/web/package.json'), '{ "name": "@acme/web" }\n');
    return root;
  };

  test('a package source is read, a test and a dependency are not, and the gate reports it', async () => {
    const root = await app();
    const bad = "import { list } from '@acme/web/app/post/repo';\nlist();\n";
    await Bun.write(join(root, FROM), bad);
    await Bun.write(join(root, 'packages/domain/src/a.test.ts'), bad);
    await Bun.write(join(root, 'packages/domain/node_modules/x/index.ts'), bad);
    await Bun.write(join(root, 'packages/domain/dist/index.ts'), bad);
    expect((await readPackageSources(root)).map((file) => file.path)).toEqual([FROM]);
    expect((await packageBoundaryFindings(root)).map((one) => one.at)).toEqual([FROM]);
    const gate = await appBoundaryFindings(root);
    expect(gate.map((one) => one.code)).toContain('X_BOUNDARY_PACKAGE_TO_APP');
  });

  test('a tree with no apps/ asks nothing: the framework repository itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-package-boundaries-'));
    roots.push(root);
    await Bun.write(join(root, FROM), "import '../../../apps/web/a';\n");
    expect(await packageBoundaryFindings(root)).toEqual([]);
  });

  test.each(['examples/dummy', 'dummy/social-media-clone'])(
    'the tracked app %s is clean',
    async (app) => {
      expect(await packageBoundaryFindings(join(workspaceRoot(), app))).toEqual([]);
    },
  );
});
