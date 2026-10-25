// Workspace declarations, source edges, and executable fixes must agree without losing manifest data.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { $ } from 'bun';
import { writeNewApp } from './cmd-new';
import { VERIFY_STEPS } from './cmd-verify';
import { fixProblem } from './error-contract';
import {
  checkWorkspaceDependencies,
  importedPackages,
  packageOfSpecifier,
  readWorkspaceGraph,
  workspaceGlobs,
} from './workspace-graph';

const ROOT_MANIFEST = JSON.stringify({
  name: 'demo-root',
  private: true,
  workspaces: ['apps/*', 'packages/*'],
});

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-workspace-graph-'));
  await Bun.write(join(dir, 'package.json'), ROOT_MANIFEST);
  // `web` declares i18n and imports it — the control, so a finding against it is a real one.
  await Bun.write(
    join(dir, 'apps/web/package.json'),
    '{"name":"@demo/web","version":"0.0.0","dependencies":{"@demo/i18n":"0.0.0","solid-js":"1.9.14"}}',
  );
  await Bun.write(
    join(dir, 'apps/web/site/page.tsx'),
    "import { useT } from '@demo/i18n';\nimport { render } from 'solid-js';\nexport const page = { useT, render };\n",
  );
  await Bun.write(
    join(dir, 'packages/i18n/package.json'),
    '{"name":"@demo/i18n","version":"0.0.0"}',
  );
  await Bun.write(join(dir, 'packages/i18n/src/index.ts'), 'export const useT = () => null;\n');
  // `mcp` imports the app and declares nothing: the scaffold's own defect, and the one this rule
  // exists to catch.
  await Bun.write(join(dir, 'packages/mcp/package.json'), '{"name":"@demo/mcp","version":"2.1.0"}');
  await Bun.write(
    join(dir, 'packages/mcp/src/index.ts'),
    "import * as api from '@demo/web/api/health';\nexport const tools = api;\n",
  );
  // A second import site for the same missing pin: the fix is still one line in one manifest.
  await Bun.write(
    join(dir, 'packages/mcp/src/tools.ts'),
    "import { health } from '@demo/web/api/index';\nexport const list = [health];\n",
  );
  // A test file's imports resolve through the ROOT manifest's hoisted devDependencies and never
  // reach a tarball, so the rule deliberately cannot see this one.
  await Bun.write(
    join(dir, 'packages/i18n/src/index.test.ts'),
    "import { tools } from '@demo/mcp';\nexport const seen = tools;\n",
  );
  // Not a workspace at all, and its import of a workspace package must stay unreported: the rule
  // is about manifests the root claims, not about every directory on disk.
  await Bun.write(join(dir, 'scripts/tool.ts'), "import '@demo/web';\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('unit · the workspace graph', () => {
  test('every workspace the root claims is a node, with its own directory', async () => {
    const graph = await readWorkspaceGraph(dir);

    expect(graph.map((node) => node.name)).toEqual(['@demo/web', '@demo/i18n', '@demo/mcp']);
    expect(graph.map((node) => node.dir)).toEqual(['apps/web', 'packages/i18n', 'packages/mcp']);
    expect(graph.map((node) => node.version)).toEqual(['0.0.0', '0.0.0', '2.1.0']);
  });

  // A dep on a registry package is not an edge in this graph: `solid-js` is installed, not built
  // here, so an affected-set that counted it would name every workspace on every lockfile change.
  test('only edges to other workspaces count', async () => {
    const graph = await readWorkspaceGraph(dir);
    const web = graph.find((node) => node.name === '@demo/web');

    expect(web?.dependencies).toEqual(['@demo/i18n']);
    expect(graph.find((node) => node.name === '@demo/mcp')?.dependencies).toEqual([]);
  });

  // One unreadable manifest must not hide its readable siblings.
  test('a manifest that will not parse is skipped, not thrown from', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'ultimate-workspace-graph-broken-'));
    try {
      await Bun.write(join(broken, 'package.json'), ROOT_MANIFEST);
      await Bun.write(join(broken, 'packages/bad/package.json'), '{ "name": "@demo/bad", }{');
      await Bun.write(join(broken, 'packages/ok/package.json'), '{"name":"@demo/ok"}');

      const graph = await readWorkspaceGraph(broken);

      expect(graph.map((node) => node.name)).toEqual(['@demo/ok']);
      // No `version` in the manifest is `0.0.0`, so the fix line always has a range to name.
      expect(graph[0]?.version).toBe('0.0.0');
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  test('a root with no workspaces field is an empty graph, and no error', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'ultimate-workspace-graph-plain-'));
    try {
      await Bun.write(join(plain, 'package.json'), '{"name":"solo"}');
      expect(await readWorkspaceGraph(plain)).toEqual([]);
      // A directory with no package.json at all reads the same way — `x verify` runs in one.
      expect(await readWorkspaceGraph(join(plain, 'nowhere'))).toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test('the yarn object spelling of workspaces is read too', () => {
    expect(workspaceGlobs({ workspaces: { packages: ['packages/*'] } })).toEqual(['packages/*']);
    expect(workspaceGlobs({ workspaces: ['apps/*'] })).toEqual(['apps/*']);
    expect(workspaceGlobs({ workspaces: [1, 'apps/*'] })).toEqual(['apps/*']);
    expect(workspaceGlobs({})).toEqual([]);
    expect(workspaceGlobs(null)).toEqual([]);
  });
});

describe('unit · what a source file imports', () => {
  test('every form that names a module is read', () => {
    const source = [
      "import { a } from '@demo/one';",
      "import type { B } from '@demo/two/sub/deep';",
      "export * from 'three';",
      "import '@demo/four/styles.css';",
      "const five = await import('@demo/five');",
      "const six = require('six');",
    ].join('\n');

    expect(importedPackages(source)).toEqual([
      '@demo/one',
      '@demo/two',
      'three',
      '@demo/four',
      '@demo/five',
      'six',
    ]);
  });

  test('a relative, absolute or protocol specifier names no package', () => {
    expect(packageOfSpecifier('./sibling')).toBeUndefined();
    expect(packageOfSpecifier('../../up')).toBeUndefined();
    expect(packageOfSpecifier('/abs')).toBeUndefined();
    expect(packageOfSpecifier('node:path')).toBeUndefined();
    expect(packageOfSpecifier('bun:test')).toBeUndefined();
    expect(packageOfSpecifier('@scope')).toBeUndefined();
    expect(packageOfSpecifier('')).toBeUndefined();
    expect(packageOfSpecifier('pkg')).toBe('pkg');
    expect(packageOfSpecifier('@scope/pkg/deep/path')).toBe('@scope/pkg');
  });

  // Template imports belong to the emitted app, not the generator.
  test('an import inside a template literal belongs to the emitted file, not to this one', () => {
    const source = [
      "import { join } from 'node:path';",
      'export const page = (): string => `',
      "import { useT } from '@demo/i18n';",
      "import { Button } from '@ultimat3/ui';",
      '`;',
    ].join('\n');

    expect(importedPackages(source)).toEqual([]);
  });

  // #493: nested template imports must not be charged to the generator either.
  test('an import inside a nested template belongs to the emitted file too (#493)', () => {
    const source = [
      'export const page = (): string => `',
      '${sortedImports([',
      "  `import { Button } from '@ultimat3/ui';`,",
      '])}',
      'export const x = 1;',
      '`;',
    ].join('\n');

    expect(importedPackages(source)).toEqual([]);
  });

  test('a type-position import(…) needs its manifest line like `import type` (K16)', () => {
    const source = [
      "export type Cli = typeof import('@demo/one');",
      "export let row: import('@demo/two/row').Row;",
      "export const prose = `typeof import('@demo/three')`;",
    ].join('\n');

    expect(importedPackages(source)).toEqual(['@demo/one', '@demo/two']);
  });

  test('a file the parser refuses is not silently read as importing nothing', () => {
    expect(() => importedPackages("import { a } from '@demo/one';\nconst = ;")).toThrow();
  });

  // `from(…)` is the query builder's own opening call and reads exactly like an import.
  test("a `from('table')` call is not an import", () => {
    expect(importedPackages("const rows = from<Row>('posts', () => repo.page());")).toEqual([]);
    expect(importedPackages("const q = { from: 'posts' };")).toEqual([]);
    expect(importedPackages("const list = Array.from('abc');")).toEqual([]);
  });
});

describe('unit · every workspace import is declared', () => {
  test('an undeclared workspace import is a finding naming the manifest and the line to add', async () => {
    const findings = await checkWorkspaceDependencies(dir);

    expect(findings.map((finding) => finding.code)).toEqual(['X_WORKSPACE_DEP_UNDECLARED']);
    expect(findings[0]?.at).toBe('packages/mcp/package.json');
    expect(findings[0]?.cause).toBe(
      'packages/mcp/src/index.ts imports @demo/web, which packages/mcp/package.json does not declare',
    );
    // The version is the target's own: a range that resolves and then fails the lockstep rule is
    // an edit that trades one red gate for another.
    expect(findings[0]?.fix).toBe(
      'add "@demo/web": "0.0.0" to "dependencies" in packages/mcp/package.json',
    );
  });

  test('a declared import is not a finding, and neither is a registry package', async () => {
    const findings = await checkWorkspaceDependencies(dir);
    const causes = findings.map((finding) => finding.cause).join('\n');

    expect(causes).not.toContain('@demo/i18n');
    expect(causes).not.toContain('solid-js');
  });

  // `scripts/` is shipped source by `SOURCE_GLOBS` and belongs to no workspace. Charged to the
  // root it would name a manifest whose `dependencies` nobody installs per package.
  test('a source file outside every workspace is charged to none of them', async () => {
    for (const finding of await checkWorkspaceDependencies(dir)) {
      expect(finding.cause).not.toContain('scripts/tool.ts');
    }
  });

  test('a test file is not judged', async () => {
    const causes = (await checkWorkspaceDependencies(dir)).map((finding) => finding.cause);

    expect(causes.join('\n')).not.toContain('index.test.ts');
  });

  // Deepest directory wins: the resolver consults the nested manifest.
  test('a file inside a nested workspace is charged to the nested one', async () => {
    const nested = await mkdtemp(join(tmpdir(), 'ultimate-workspace-graph-nested-'));
    try {
      await Bun.write(
        join(nested, 'package.json'),
        JSON.stringify({ name: 'nested-root', workspaces: ['apps/*', 'apps/*/shared'] }),
      );
      await Bun.write(join(nested, 'apps/web/package.json'), '{"name":"@demo/web"}');
      await Bun.write(
        join(nested, 'apps/web/shared/package.json'),
        '{"name":"@demo/shared","version":"3.0.0"}',
      );
      await Bun.write(join(nested, 'apps/web/shared/ui.ts'), "import '@demo/web';\n");

      const findings = await checkWorkspaceDependencies(nested);

      expect(findings[0]?.at).toBe('apps/web/shared/package.json');
    } finally {
      await rm(nested, { recursive: true, force: true });
    }
  });

  // Skipping an unreadable manifest must produce a finding, not a hiding place.
  test('a manifest the graph could not read is a finding of its own', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'ultimate-workspace-graph-skip-'));
    try {
      await Bun.write(join(broken, 'package.json'), ROOT_MANIFEST);
      await Bun.write(join(broken, 'packages/bad/package.json'), '{ "name": "@demo/bad", }{');
      await Bun.write(join(broken, 'packages/nameless/package.json'), '{"version":"1.0.0"}');

      const findings = await checkWorkspaceDependencies(broken);

      expect(findings.map((finding) => finding.at)).toEqual([
        'packages/bad/package.json',
        'packages/nameless/package.json',
      ]);
      expect(findings.every((finding) => finding.code === 'X_APP_PACKAGE_INVALID')).toBe(true);
      expect(fixProblem(findings[0]?.fix ?? '')).toBeUndefined();
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  test('every finding carries a fix the error contract accepts', async () => {
    for (const finding of await checkWorkspaceDependencies(dir)) {
      expect(fixProblem(finding.fix)).toBeUndefined();
    }
  });

  // #239: both scaffold shapes must declare the cross-workspace edges they emit.
  for (const example of [true, false]) {
    test(`x new --${example ? 'example' : 'no-example'} declares every edge it emits`, async () => {
      const app = await mkdtemp(join(tmpdir(), 'ultimate-workspace-graph-scaffold-'));
      try {
        await writeNewApp(app, { name: 'graphdemo', example });
        expect(await checkWorkspaceDependencies(app)).toEqual([]);
        // Not vacuous: the app really does import across its own workspaces.
        const graph = await readWorkspaceGraph(app);
        expect(graph.flatMap((node) => node.dependencies).length).toBeGreaterThan(0);
      } finally {
        await rm(app, { recursive: true, force: true });
      }
    });
  }

  test('a repo with no workspaces has nothing to check', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'ultimate-workspace-graph-none-'));
    try {
      await Bun.write(join(plain, 'package.json'), '{"name":"solo"}');
      // A directory that LOOKS like a workspace and is claimed by no glob. `packages/*` is a
      // convention, never the default — the root manifest is the only thing that decides.
      await Bun.write(join(plain, 'packages/x/package.json'), '{"name":"@demo/x"}');
      await Bun.write(join(plain, 'packages/x/src/index.ts'), "import '@demo/i18n';\n");
      await Bun.write(join(plain, 'packages/i18n/package.json'), '{"name":"@demo/i18n"}');
      expect(await checkWorkspaceDependencies(plain)).toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('unit · declared framework siblings are used by shipped source', () => {
  const runtime = ['dependencies'] as const;
  const dev = ['devDependencies'] as const;
  const shipped = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;
  const fixture = 'src/helper-fixture.ts';
  const source = "import '@ultimat3/core';";
  const typeOnly = "import type { Row } from '@ultimat3/core/types';";
  const typePosition = "export type Row = import('@ultimat3/core').Row;";
  const cases = [
    ['unused', undefined, '', runtime, runtime],
    ['runtime import', 'src/index.ts', source, runtime, []],
    ['type-only subpath', 'src/index.ts', typeOnly, runtime, []],
    ['type-position import', 'src/index.ts', typePosition, runtime, []],
    ['test-only', 'src/index.test.ts', source, runtime, runtime],
    ['fixture undeclared', fixture, source, [], []],
    ['fixture runtime', fixture, source, runtime, runtime],
    ['fixture dev', fixture, source, dev, []],
    ['fixture mixed', fixture, source, [...dev, ...shipped], shipped],
    ['unused dev', undefined, '', dev, dev],
    ['declaration-only', 'src/index.d.ts', source, runtime, runtime],
  ] as const;
  for (const [label, path, source, fields, unusedFields] of cases) {
    test(`${label} usage has the expected reverse verdict`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ultimate-workspace-unused-'));
      try {
        await Bun.write(join(root, 'package.json'), ROOT_MANIFEST);
        const manifest: Record<string, unknown> = {
          name: '@demo/owner',
          scripts: { check: 'bun test' },
          custom: { keep: ['unchanged'] },
          ...Object.fromEntries(
            fields.map((field) => [field, { '@ultimat3/core': '1.0.0', external: '2.0.0' }]),
          ),
        };
        const manifestPath = join(root, 'packages/owner/package.json');
        await Bun.write(manifestPath, JSON.stringify(manifest));
        await Bun.write(join(root, 'packages/core/package.json'), '{"name":"@ultimat3/core"}');
        if (path !== undefined) await Bun.write(join(root, 'packages/owner', path), source);
        const findings = await checkWorkspaceDependencies(root);
        if (fields.length === 0) {
          expect(findings).toHaveLength(1);
          expect(findings[0]?.code).toBe('X_WORKSPACE_DEP_UNDECLARED');
          expect(findings[0]?.cause).toContain('helper-fixture.ts');
          expect(findings[0]?.fix).toBe(
            'add "@ultimat3/core": "0.0.0" to "devDependencies" in packages/owner/package.json',
          );
          expect(fixProblem(findings[0]?.fix ?? '')).toBeUndefined();
          return;
        }
        if (unusedFields.length === 0) {
          expect(findings).toEqual([]);
          return;
        }
        expect(findings).toHaveLength(1);
        expect(findings[0]?.code).toBe('X_PACKAGE_SHAPE');
        expect(findings[0]?.at).toBe('packages/owner/package.json');
        expect(findings[0]?.cause).toContain('@ultimat3/core');
        expect(findings[0]?.cause).toContain('packages/owner/package.json');
        for (const field of unusedFields) expect(findings[0]?.cause).toContain(field);
        const fix = findings[0]?.fix ?? '';
        expect(fix).toStartWith('bun -e ');
        expect(fixProblem(fix)).toBeUndefined();
        if (label === 'unused') {
          const step = VERIFY_STEPS.find((candidate) => candidate.name === 'package-shape');
          const result = await step?.run({ root, runner: async () => ({}) as never });
          expect(result?.ok).toBe(false);
          expect(result?.findings).toContainEqual(findings[0]);
        }
        await $`${{ raw: fix }}`.cwd(root).quiet();
        const expected = structuredClone(manifest);
        for (const field of unusedFields) {
          delete (expected[field] as Record<string, unknown>)['@ultimat3/core'];
        }
        expect(await Bun.file(manifestPath).json()).toEqual(expected);
        const after = await checkWorkspaceDependencies(root);
        const codes = label === 'fixture runtime' ? ['X_WORKSPACE_DEP_UNDECLARED'] : [];
        expect(after.map(({ code }) => code)).toEqual(codes);
        if (label === 'fixture runtime') expect(after[0]?.cause).toContain('helper-fixture.ts');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test('catalog roots exempt only the CLI; sibling declarations deduplicate across fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-workspace-catalog-'));
    try {
      await Bun.write(join(root, 'package.json'), ROOT_MANIFEST);
      const ownerDir = "packages/owner's $HOME; $(echo unsafe)";
      for (const name of ['cli', 'owner']) {
        await Bun.write(
          join(root, name === 'cli' ? 'packages/cli/package.json' : `${ownerDir}/package.json`),
          JSON.stringify({
            name: `@ultimat3/${name}`,
            dependencies: {
              '@ultimat3/core': '1.0.0',
              '@demo/local': '1.0.0',
              'solid-js': '1.0.0',
            },
            devDependencies: { '@ultimat3/core': '1.0.0' },
            peerDependencies: { '@ultimat3/core': '1.0.0' },
            optionalDependencies: { '@ultimat3/core': '1.0.0' },
          }),
        );
      }
      await Bun.write(join(root, 'packages/core/package.json'), '{"name":"@ultimat3/core"}');
      await Bun.write(join(root, 'packages/local/package.json'), '{"name":"@demo/local"}');
      const findings = await checkWorkspaceDependencies(root);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.at).toBe(`${ownerDir}/package.json`);
      const ownerPath = join(root, ownerDir, 'package.json');
      const before = await Bun.file(ownerPath).json();
      const cliBefore = await Bun.file(join(root, 'packages/cli/package.json')).text();
      const fix = findings[0]?.fix ?? '';
      expect(fix).toStartWith('bun -e ');
      expect(fixProblem(fix)).toBeUndefined();
      await $`${{ raw: fix }}`.cwd(root).quiet();
      for (const field of [...dev, ...shipped]) delete before[field]['@ultimat3/core'];
      expect(await Bun.file(ownerPath).json()).toEqual(before);
      expect(await Bun.file(join(root, 'packages/cli/package.json')).text()).toBe(cliBefore);
      expect(await checkWorkspaceDependencies(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Nested apps run this guard from their own root, not through the outer manifest scan.
  for (const appDir of ['examples/demo', 'dummy/demo']) {
    test(`${appDir} is excluded outside, but checked from its own root`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ultimate-workspace-scope-'));
      try {
        const app = join(root, appDir);
        await Bun.write(
          join(root, 'package.json'),
          JSON.stringify({ workspaces: [`${appDir}/packages/*`] }),
        );
        await Bun.write(join(app, 'package.json'), ROOT_MANIFEST);
        await Bun.write(join(app, 'packages/core/package.json'), '{"name":"@ultimat3/core"}');
        await Bun.write(
          join(app, 'packages/owner/package.json'),
          JSON.stringify({ name: '@demo/owner', dependencies: { '@ultimat3/core': '1.0.0' } }),
        );
        await Bun.write(join(app, 'packages/owner/src/index.ts'), "import '@ultimat3/core';");
        expect(await checkWorkspaceDependencies(root)).toEqual([]);
        expect(await checkWorkspaceDependencies(app)).toEqual([]);
        await Bun.write(join(app, 'packages/owner/src/index.ts'), 'export const value = 1;');
        const findings = await checkWorkspaceDependencies(app);
        expect(findings.map(({ code, at }) => ({ code, at }))).toEqual([
          { code: 'X_PACKAGE_SHAPE', at: 'packages/owner/package.json' },
        ]);
        expect(fixProblem(findings[0]?.fix ?? '')).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
// Use the real gate step: a check nothing calls is a check that passes forever.
describe('unit · the rule is wired into `x verify`', () => {
  test('the `package-shape` step reports an undeclared workspace import', async () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'package-shape');
    expect(await step?.applies?.({ root: dir, runner: async () => ({}) as never })).toBe(true);
    const result = await step?.run({ root: dir, runner: async () => ({}) as never });
    expect(result?.ok).toBe(false);
    expect(result?.findings.map((finding) => finding.code)).toContain('X_WORKSPACE_DEP_UNDECLARED');
  });
});
