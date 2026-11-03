// A declared framework sibling is used by shipped source. Split out of `workspace-graph.test.ts`
// at the file ceiling.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { $ } from 'bun';
import { VERIFY_STEPS } from './cmd-verify';
import { fixProblem } from './error-contract';
import { checkWorkspaceDependencies } from './workspace-graph';

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
