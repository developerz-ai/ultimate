// The codemod that carries an app to mergeable registries: it lands what `x new` now writes, is
// idempotent, and leaves what it cannot restate.

import { describe, expect, test } from 'bun:test';
import { REGISTRY_LINE_COMMENT } from '../registry-lines';
import { MERGE_ATTRIBUTES } from '../templates/scaffold-gitattributes';
import { memoryCodemodApp } from './codemod';
import {
  API_INDEX_TEST,
  apiIndexTest,
  codemod,
  INSTALL_STEP,
  SHELL_INSTALL_STEP,
} from './merge-drivers';

const SETUP = "await bun('install');\nawait x('db', 'seed');\n";
const API = `export const api = defineApi({\n  actions: [health],\n});\n`;

const app = (over: Record<string, string> = {}) =>
  memoryCodemodApp({
    '.gitattributes': '* text=auto eol=lf\n',
    'bin/setup.ts': SETUP,
    'apps/web/api/index.ts': API,
    ...over,
  });

describe('unit · merge-drivers codemod', () => {
  test('adds the rules, the setup step and the one-per-line lists', async () => {
    const target = app();
    const result = await codemod.run(target);
    expect(result.skipped).toEqual([]);
    expect([...result.changed].sort()).toEqual([
      '.gitattributes',
      'apps/web/api/index.test.ts',
      'apps/web/api/index.ts',
      'bin/setup.ts',
    ]);
    expect(target.files['.gitattributes']).toBe(`* text=auto eol=lf\n\n${MERGE_ATTRIBUTES}`);
    expect(target.files['bin/setup.ts']).toBe(
      `await bun('install');\n${INSTALL_STEP}await x('db', 'seed');\n`,
    );
    expect(target.files['apps/web/api/index.ts']).toContain(
      `actions: [\n    ${REGISTRY_LINE_COMMENT}\n    health,\n  ],`,
    );
  });

  test('a second run changes nothing', async () => {
    const target = app();
    await codemod.run(target);
    expect(await codemod.run(target)).toEqual({ changed: [], skipped: [] });
  });

  test('a rewritten setup script is reported, never guessed at', async () => {
    const target = app({ 'bin/setup.ts': 'await myInstall();\n' });
    const result = await codemod.run(target);
    expect(target.files['bin/setup.ts']).toBe('await myInstall();\n');
    expect(result.skipped.map((one) => one.path)).toEqual(['bin/setup.ts']);
    expect(result.skipped[0]?.reason).toContain(INSTALL_STEP.trim());
  });

  // one adopter: the spread index.ts grew 21 lines no unit test loaded, and the gate's
  // coverage floor went red on an upgrade that changed no behaviour.
  describe('the spread registration is loaded by a unit test', () => {
    test('writes the registration test beside an index.ts no test sits beside', async () => {
      const target = app();
      const result = await codemod.run(target);
      expect(result.changed).toContain(API_INDEX_TEST);
      expect(target.files[API_INDEX_TEST]).toBe(apiIndexTest());
    });

    test('the written test imports the api the index exports and reads every list', () => {
      const source = apiIndexTest();
      const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(source);
      expect(imports.map((one) => one.path).sort()).toEqual(['./index', '@ultimat3/testing']);
      expect(source).toContain("import { api } from './index';");
      for (const list of ['actions', 'queries', 'jobs', 'tasks']) {
        expect(source).toContain(`api.${list}`);
      }
      for (const line of source.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    });

    test('an app that already tests its registration keeps its own test', async () => {
      const target = app({ [API_INDEX_TEST]: 'mine\n' });
      const result = await codemod.run(target);
      expect(target.files[API_INDEX_TEST]).toBe('mine\n');
      expect(result.changed).not.toContain(API_INDEX_TEST);
    });

    test('an index.ts left as it was gains no test', async () => {
      const target = app();
      await codemod.run(target);
      delete target.files[API_INDEX_TEST];
      expect((await codemod.run(target)).changed).toEqual([]);
    });

    test('an index exporting no `api` is reported with the test to write, never guessed at', async () => {
      const target = app({ 'apps/web/api/index.ts': API.replace('const api', 'const routes') });
      const result = await codemod.run(target);
      expect(target.files[API_INDEX_TEST]).toBeUndefined();
      expect(result.skipped.map((one) => one.path)).toEqual([API_INDEX_TEST]);
    });
  });

  // two adopters: `"setup": "bin/setup"` is bash, there is no bin/setup.ts,
  // and the step went missing with nothing in `changed` or `skipped` to say so.
  describe('an app whose setup is not bin/setup.ts', () => {
    const shellApp = (setup: string, files: Record<string, string> = {}) => {
      const target = app({ 'package.json': JSON.stringify({ scripts: { setup } }), ...files });
      delete target.files['bin/setup.ts'];
      return target;
    };

    test('names the script package.json runs and the line to add by hand', async () => {
      const script = '#!/usr/bin/env bash\nset -euo pipefail\nbun install\n';
      const target = shellApp('bin/setup', { 'bin/setup': script });
      const result = await codemod.run(target);
      expect(target.files['bin/setup']).toBe(script);
      expect(result.skipped.map((one) => one.path)).toEqual(['bin/setup']);
      expect(result.skipped[0]?.reason).toContain(SHELL_INSTALL_STEP);
    });

    test('reads the script through an interpreter prefix', async () => {
      const target = shellApp('bash ./bin/setup --fast', { 'bin/setup': 'bun install\n' });
      const result = await codemod.run(target);
      expect(result.skipped.map((one) => one.path)).toEqual(['bin/setup']);
    });

    test('a script that already installs the drivers is left unreported', async () => {
      const target = shellApp('bin/setup', {
        'bin/setup': `bun install\n${SHELL_INSTALL_STEP}\n`,
      });
      expect((await codemod.run(target)).skipped).toEqual([]);
    });

    test('a setup that names no file in the app points at package.json', async () => {
      const target = shellApp('make setup');
      const result = await codemod.run(target);
      expect(result.skipped.map((one) => one.path)).toEqual(['package.json']);
      expect(result.skipped[0]?.reason).toContain(SHELL_INSTALL_STEP);
    });
  });
});
