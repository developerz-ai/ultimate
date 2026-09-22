// A browser store imports an entity's record projection; it must not import the Postgres driver
// with it. Measured on the artifact: `Bun.build` with `minify: false` writes one `// <path>` banner
// per retained module, so the retained SET is read off the chunk and a regression names its file.
//
// Two entries, two claims. `@ultimat3/entity/record` is the browser path and retains nothing of
// the driver. The package barrel is measured beside it and DOES retain the SQL renderer — the
// package declares no `sideEffects`, so every module with a top-level statement survives — which
// is the whole reason the subpath exists; if the barrel ever shakes clean, that assertion fails
// and the subpath can be deleted as a second import idiom (axiom 1).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry must be written INSIDE the package so `@ultimat3/*`
// resolves through its node_modules, and each banner is resolved back to an absolute path.
import { join, resolve } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `record-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

const ENTRY_SOURCE = (specifier: string): string =>
  `import { ENTITY_BRAND, hasEntityRows, recordProjection, recordTypeForTable, rowsOf } from '${specifier}';\n` +
  'globalThis.probe = [ENTITY_BRAND, hasEntityRows, recordProjection, recordTypeForTable, rowsOf];\n';

/** Every retained module as a path relative to `packages/`, sorted, plus the code itself. */
async function build(
  name: string,
  specifier: string,
): Promise<{ modules: string[]; code: string }> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, ENTRY_SOURCE(specifier));
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    minify: false,
  });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${name} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const code = await output.text();
  const modules: string[] = [];
  for (const line of code.split('\n')) {
    if (!line.startsWith('// ')) continue;
    const path = resolve(process.cwd(), line.slice(3));
    if (path.startsWith(`${PACKAGES}/`) && (await Bun.file(path).exists())) {
      modules.push(path.slice(PACKAGES.length + 1));
    }
  }
  return { modules: modules.sort(), code };
}

/** What "the Postgres driver" is in a chunk: this package's SQL half, and `@ultimat3/db`. */
const isDriverModule = (module: string): boolean =>
  /^entity\/src\/pg-/.test(module) || module.startsWith('db/src/');

describe('the browser path to an entity’s record projection', () => {
  test('@ultimat3/entity/record retains no driver module', async () => {
    const { modules, code } = await build('record', '@ultimat3/entity/record');
    expect(modules.filter(isDriverModule)).toEqual([]);
    expect(code).not.toContain('postgresDriver');
    // A list, so an entity module that starts riding along is named rather than counted.
    expect(modules.filter((module) => module.startsWith('entity/src/'))).toEqual([
      'entity/src/entity-error.ts',
      'entity/src/record-projection.ts',
      'entity/src/record-table.ts',
      'entity/src/registry.ts',
      'entity/src/rows-of.ts',
    ]);
  }, 60_000);

  test('the barrel still drags the SQL renderer — the reason the subpath exists', async () => {
    const { modules } = await build('barrel', '@ultimat3/entity');
    expect(modules.filter(isDriverModule).length).toBeGreaterThan(0);
  }, 60_000);
});
