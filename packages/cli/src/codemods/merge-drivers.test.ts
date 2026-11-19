// The codemod that carries an app to mergeable registries: it lands what `x new` now writes, is
// idempotent, and leaves what it cannot restate.

import { describe, expect, test } from 'bun:test';
import { REGISTRY_LINE_COMMENT } from '../registry-lines';
import { MERGE_ATTRIBUTES } from '../templates/scaffold-gitattributes';
import { memoryCodemodApp } from './codemod';
import { codemod, INSTALL_STEP } from './merge-drivers';

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
});
