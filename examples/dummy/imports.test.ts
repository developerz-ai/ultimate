/**
 * Every module in this app loads against the real package APIs — in both senses, because they
 * fail differently:
 *
 * 1. it imports. The framework does most of its work at declaration time (`defineRoute`,
 *    `defineMail`, `defineAdmin`, `defineApi`, `entity()`), so a declaration the framework refuses
 *    throws on import and nowhere else.
 * 2. every name it imports is really exported. Bun's test runner links lazily, so a symbol the
 *    packages never shipped is silently `undefined` here and a hard error under `bun run` — which
 *    is how half this app once imported `defineCatalogs`, `rpc` and `<Text>` that did not exist.
 *
 * `x dev`, `x manifest` and `x verify` boot the app by dynamic-importing exactly this file set, so
 * a module that fails either half is a module the toolchain cannot see.
 */

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

const APP_ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Test files are excluded: importing one from inside another registers its cases twice. They are
 * covered anyway — `bun test` imports every one of them.
 */
const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);

const modules = async (): Promise<readonly string[]> => {
  const found: string[] = [];
  for await (const file of new Glob('**/*.{ts,tsx}').scan({ cwd: APP_ROOT, absolute: true })) {
    if (file.includes('/node_modules/') || isTest(file)) continue;
    found.push(file);
  }
  return found.sort();
};

const relative = (file: string): string => file.slice(APP_ROOT.length + 1);

/**
 * `import { a, b as c } from 'x'` only. `import type { … }` is skipped because a type is not an
 * export at runtime, and `verbatimModuleSyntax` is on — so every *other* named import in this app
 * is a value import, which is what makes the check sound rather than approximate.
 */
const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g;

interface NamedImport {
  readonly specifier: string;
  readonly names: readonly string[];
}

const namedImportsOf = (source: string): readonly NamedImport[] => {
  const found: NamedImport[] = [];
  for (const match of source.matchAll(NAMED_IMPORT)) {
    if (match[1] !== undefined) continue;
    const names = (match[2] ?? '')
      .split(',')
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !clause.startsWith('type '))
      .map((clause) => (clause.split(/\s+as\s+/)[0] ?? '').trim());
    if (names.length > 0) found.push({ specifier: match[3] ?? '', names });
  }
  return found;
};

describe('every app module', () => {
  test('imports against the real package APIs', async () => {
    const files = await modules();
    expect(files.length).toBeGreaterThan(50);

    const broken: string[] = [];
    for (const file of files) {
      try {
        await import(file);
      } catch (error) {
        broken.push(
          `${relative(file)}: ${String((error as Error).message ?? error).split('\n')[0]}`,
        );
      }
    }

    expect(broken).toEqual([]);
  });

  test('imports only names those packages actually export', async () => {
    const files = await modules();
    const missing: string[] = [];

    for (const file of files) {
      const source = await Bun.file(file).text();
      for (const { specifier, names } of namedImportsOf(source)) {
        let module: Record<string, unknown>;
        try {
          module = (await import(
            Bun.resolveSync(specifier, file.replace(/\/[^/]+$/, ''))
          )) as Record<string, unknown>;
        } catch (error) {
          missing.push(
            `${relative(file)}: '${specifier}' — ${String((error as Error).message).split('\n')[0]}`,
          );
          continue;
        }
        for (const name of names) {
          if (name in module) continue;
          missing.push(`${relative(file)}: '${specifier}' exports no '${name}'`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
