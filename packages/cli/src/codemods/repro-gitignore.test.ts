// The repro-gitignore codemod: an app's `.gitignore` gains the line that keeps an `x repro --bundle`
// file out of a commit — once, whatever the file's last newline — the same line `x new` writes. No
// `.gitignore` is reported, never created: which files an app commits is its own.

import { describe, expect, test } from 'bun:test';
import { names, repoFiles } from '../templates';
import { memoryCodemodApp } from './codemod';
import { codemod, REPRO_BUNDLE_IGNORE } from './repro-gitignore';

describe('unit · codemod repro-gitignore', () => {
  test('carries 31.28.0, the line `x new` now writes', () => {
    expect(codemod.since).toBe('31.28.0');
    const scaffold = repoFiles(names('shop'), '0.0.0', false).find((f) => f.path === '.gitignore');
    expect(String(scaffold?.contents).split('\n')).toContain(REPRO_BUNDLE_IGNORE);
  });

  test('a .gitignore without it gains it, and a second run changes nothing', async () => {
    const app = memoryCodemodApp({ '.gitignore': 'node_modules/\n.x/' });
    expect(await codemod.run(app)).toEqual({ changed: ['.gitignore'], skipped: [] });
    expect(app.files['.gitignore']).toBe(`node_modules/\n.x/\n${REPRO_BUNDLE_IGNORE}\n`);
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a .gitignore that already ignores the bundles, or all of repro/, is left alone', async () => {
    for (const source of [`node_modules/\n${REPRO_BUNDLE_IGNORE}\n`, 'repro/\n', '/repro/\n']) {
      const app = memoryCodemodApp({ '.gitignore': source });
      expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
      expect(app.files['.gitignore']).toBe(source);
    }
  });

  test('no .gitignore is reported with the line it would add, and none is created', async () => {
    const app = memoryCodemodApp({ 'package.json': '{}' });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ path: '.gitignore', diff: `+${REPRO_BUNDLE_IGNORE}` }),
    ]);
    expect(app.files['.gitignore']).toBeUndefined();
  });
});
