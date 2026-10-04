// The one-config-loader rule: every spelling the seventeen deleted walks used is refused outside
// the loader, the loader and the tier-forced exemption are not, and the real tree is clean.

import { describe, expect, test } from 'bun:test';
import { collectSourceFiles } from '../boundaries';
import {
  CONFIG_IMPORT_EXEMPT,
  CONFIG_LOADER_FILE,
  checkConfigImports,
  configImportFindingFor,
} from './config-import';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

const file = (path: string, source: string) => ({ path, source });
const CLI = 'packages/cli/src/theme-boot.ts';

describe('unit · one config loader', () => {
  test.each([
    [
      'a joined binding',
      'const configPath = join(root, APP_CONFIG_FILE);\nawait import(configPath);',
    ],
    ['another binding name', 'const path = join(root, APP_CONFIG_FILE);\nawait import(path);'],
    ['the join inline', 'await import(join(root, APP_CONFIG_FILE));'],
    // Joined on `$` so the fixture holds a real `${…}` without one in this file's own string.
    ['a template', ['await import(`', '{root}/', '{APP_CONFIG_FILE}`);'].join('$')],
    ['the literal file name', "await import(join(root, 'app.config.ts'));"],
    ['a resolved root', 'const app = findAppRoot(cwd);\nawait import(app.configPath);'],
  ])('%s outside the loader is refused, with its line', (_name, source) => {
    const [violation] = checkConfigImports([file(CLI, `// header\n${source}\n`)]);
    expect(violation?.file).toBe(CLI);
    expect(violation?.line).toBeGreaterThan(1);
    expect(configImportFindingFor(violation ?? { file: '', line: 0, specifier: '' }).code).toBe(
      'X_CONFIG_IMPORT_OUTSIDE_LOADER',
    );
  });

  test('the loader itself, a test file and the pinned exemption are not', () => {
    const source = 'const path = join(root, APP_CONFIG_FILE);\nawait import(path);\n';
    const exempt = Object.keys(CONFIG_IMPORT_EXEMPT)[0] ?? '';
    expect(
      checkConfigImports([
        file(CONFIG_LOADER_FILE, source),
        file('packages/cli/src/theme-boot.test.ts', source),
        file(exempt, source),
      ]),
    ).toEqual([]);
  });

  test('an import of anything else, or a comment naming one, is not a config import', () => {
    const source = [
      "import { APP_CONFIG_FILE } from './app-root';",
      'const absolute = join(root, file);',
      'await import(absolute);',
      "await import('./serve-web');",
      '// a second `import(configPath)` would be a second answer',
    ].join('\n');
    expect(checkConfigImports([file(CLI, source)])).toEqual([]);
  });

  test(
    'the real tree imports the config module in the loader only',
    async () => {
      const files = await collectSourceFiles(repoRoot());
      expect(checkConfigImports(files)).toEqual([]);
      // Not vacuous: the loader is in the scanned set and its own import is one the rule sees.
      const loader = files.find((one) => one.path === CONFIG_LOADER_FILE);
      if (loader === undefined) return expect.unreachable('the loader was not scanned');
      expect(checkConfigImports([{ ...loader, path: CLI }])).toHaveLength(1);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
