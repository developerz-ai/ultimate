// A registry package a workspace imports is declared by it or by the root — never only by a sibling.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { VERIFY_STEPS } from './cmd-verify';
import { fixProblem } from './error-contract';
import { checkExternalDependencies } from './workspace-external-deps';

let dir = '';

const write = (path: string, text: string) => Bun.write(join(dir, path), text);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-external-deps-'));
  await write(
    'package.json',
    JSON.stringify({
      name: 'demo-root',
      private: true,
      workspaces: ['packages/*'],
      dependencies: { 'solid-js': '1.9.14', '@ultimat3/core': '31.0.0' },
    }),
  );
  await write(
    'tsconfig.json',
    '{\n  // JSONC, as an app writes it\n  "compilerOptions": { "paths": { "~lib/*": ["./lib/*"] } },\n}\n',
  );
  // `sim` declares what it imports: the control, so a finding against it is a real one.
  await write(
    'packages/sim/package.json',
    JSON.stringify({
      name: '@demo/sim',
      version: '0.0.0',
      dependencies: { bitecs: '^0.3.40', zod: '3.23.8' },
      devDependencies: { '@types/estree': '1.0.0' },
    }),
  );
  await write(
    'packages/sim/src/index.ts',
    "import { createWorld } from 'bitecs';\nimport { z } from 'zod';\nimport type { Node } from 'estree';\nexport const world = { createWorld, z };\nexport type N = Node;\n",
  );
  // `renderer` is the adopter's tree: bitecs dropped from its manifest, still imported.
  await write('packages/renderer/package.json', '{"name":"@demo/renderer","version":"0.0.0"}');
  await write(
    'packages/renderer/src/index.tsx',
    [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'path';",
      "import { $ } from 'bun';",
      "import { Database } from 'bun:sqlite';",
      "import { world } from '@demo/sim';",
      "import { helper } from '~lib/helper';",
      "import { createSignal } from 'solid-js';",
      "import { renderCauseValue } from '@ultimat3/core';",
      "import { addEntity } from 'bitecs';",
      'export const view = () => <div>{String(createSignal)}</div>;',
      'export const all = { readFileSync, join, $, Database, world, helper, renderCauseValue, addEntity };',
      '',
    ].join('\n'),
  );
  // A second import site for the same missing package: still one finding.
  await write(
    'packages/renderer/src/system.ts',
    "import { defineQuery } from 'bitecs/core';\nexport const q = defineQuery;\n",
  );
  // A type-only import needs the package at typecheck, so it counts.
  await write(
    'packages/renderer/src/schema.ts',
    "import type { ZodType } from 'zod';\nexport type S = ZodType;\n",
  );
  // A fixture is test code: what it needs is a devDependency.
  await write(
    'packages/renderer/src/world-fixture.ts',
    "import { faker } from '@faker-js/faker';\nexport const name = faker;\n",
  );
  // Tests resolve through the root's devDependencies; out of scope, as for sibling edges.
  await write(
    'packages/renderer/src/index.test.ts',
    "import { render } from '@solidjs/testing-library';\nexport const r = render;\n",
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkExternalDependencies', () => {
  test('reports each undeclared registry import once per workspace, with a runnable bun add', async () => {
    const findings = await checkExternalDependencies(dir);
    expect(findings.map((finding) => [finding.code, finding.at, finding.fix])).toEqual([
      [
        'X_WORKSPACE_EXTERNAL_DEP_UNDECLARED',
        'packages/renderer/package.json',
        'bun add bitecs --cwd packages/renderer',
      ],
      [
        'X_WORKSPACE_EXTERNAL_DEP_UNDECLARED',
        'packages/renderer/package.json',
        'bun add zod@3.23.8 --cwd packages/renderer',
      ],
      [
        'X_WORKSPACE_EXTERNAL_DEP_UNDECLARED',
        'packages/renderer/package.json',
        'bun add @faker-js/faker --dev --cwd packages/renderer',
      ],
    ]);
    expect(findings[0]?.cause).toContain('packages/renderer/src/index.tsx imports bitecs');
  });

  test('every finding carries a fix the error contract accepts', async () => {
    const findings = await checkExternalDependencies(dir);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(fixProblem(finding.fix)).toBeUndefined();
  });

  test('a workspace name that will not travel through a shell degrades to a placeholder', async () => {
    const odd = await mkdtemp(join(tmpdir(), 'ultimate-external-deps-odd-'));
    try {
      await Bun.write(
        join(odd, 'package.json'),
        '{"name":"r","private":true,"workspaces":["packages/*"]}',
      );
      await Bun.write(join(odd, 'packages/a b/package.json'), '{"name":"@d/ab","version":"0.0.0"}');
      await Bun.write(join(odd, 'packages/a b/src/index.ts'), "export * from 'left-pad';\n");
      const [finding] = await checkExternalDependencies(odd);
      expect(finding?.fix).toBe('bun add left-pad --cwd <the workspace directory>');
    } finally {
      await rm(odd, { recursive: true, force: true });
    }
  });

  // Not vacuous on a real tree: a fresh scaffold declares every registry import it emits.
  test('x new declares every registry package it imports', async () => {
    const app = await mkdtemp(join(tmpdir(), 'ultimate-external-deps-scaffold-'));
    try {
      await writeNewApp(app, { name: 'extdemo', example: true });
      expect(await checkExternalDependencies(app)).toEqual([]);
    } finally {
      await rm(app, { recursive: true, force: true });
    }
  });

  test('the package-shape step reports it', async () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'package-shape');
    const result = await step?.run({ root: dir, runner: async () => ({}) as never });
    expect(result?.findings.map((finding) => finding.code)).toContain(
      'X_WORKSPACE_EXTERNAL_DEP_UNDECLARED',
    );
  });
});

describe('checkExternalDependencies · what counts as declared', () => {
  let app = '';
  const put = (path: string, text: string) => Bun.write(join(app, path), text);

  beforeAll(async () => {
    app = await mkdtemp(join(tmpdir(), 'ultimate-external-deps-decl-'));
    await put('package.json', '{"name":"r","private":true,"workspaces":["packages/*"]}');
    // The root's aliases come through two `extends` hops: a relative file, then a package.
    await put('tsconfig.json', '{ "extends": ["./tsconfig.base.json"] }');
    await put('tsconfig.base.json', '{ "extends": "@acme/tsconfig" }');
    await put('node_modules/@acme/tsconfig/package.json', '{"name":"@acme/tsconfig"}');
    await put(
      'node_modules/@acme/tsconfig/tsconfig.json',
      '{ "compilerOptions": { "paths": { "~pkg/*": ["./lib/*"] } } }',
    );
    // A workspace's own tsconfig, inheriting its alias from a sibling file.
    await put('packages/w/tsconfig.json', '{ "extends": "./tsconfig.local.json" }');
    await put(
      'packages/w/tsconfig.local.json',
      '{ "compilerOptions": { "paths": { "~ws/*": ["./src/*"] } } }',
    );
    await put(
      'packages/w/package.json',
      '{"name":"@d/w","version":"0.0.0","devDependencies":{"@types/lodash":"4.17.0"}}',
    );
    await put(
      'packages/w/src/aliases.ts',
      "import { a } from '~pkg/a';\nimport { b } from '~ws/b';\nexport const ab = [a, b];\n",
    );
    // `@types/lodash` types lodash; it does not install it. A type-only import needs only types.
    await put(
      'packages/w/src/types.ts',
      "import type { Dictionary } from 'lodash';\nexport type D = Dictionary<typeof import('lodash')>;\n",
    );
    await put(
      'packages/w/src/runtime.ts',
      "import { chunk } from 'lodash';\nexport const c = chunk;\n",
    );
  });

  afterAll(async () => {
    await rm(app, { recursive: true, force: true });
  });

  test('a runtime import is not covered by its @types package alone', async () => {
    const findings = await checkExternalDependencies(app);
    expect(findings.map((finding) => finding.cause.split(',')[0])).toEqual([
      'packages/w/src/runtime.ts imports lodash',
    ]);
  });

  test('aliases inherited through extends, at the root and in a workspace, are not packages', async () => {
    const causes = (await checkExternalDependencies(app)).map((finding) => finding.cause);
    expect(causes.some((cause) => cause.includes('~pkg') || cause.includes('~ws'))).toBe(false);
  });
});
