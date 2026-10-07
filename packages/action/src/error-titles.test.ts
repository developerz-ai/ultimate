// A browser chunk that reaches the action barrel renders every action code's TITLE — `problemError`
// rebuilds a server's refusal by code and reads its title from the registry — and carries the error
// CLASSES only where it constructs one. Built, run and read off the artifact on the Bun that ships,
// so a `sideEffects` change in `package.json` lands here.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/action`
// resolves through the workspace exactly as an island's import does.
import { join } from 'node:path';
import { ACTION_ERROR_TITLES } from './error-titles';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `error-titles-${process.pid}`);

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

/**
 * Bundles an island importing `name` from the barrel, which then constructs the refusal the way
 * `problemError` does — a bare code off the wire — and exports the title the registry answered.
 */
async function island(
  name: string,
): Promise<{ readonly modules: readonly string[]; readonly title: unknown }> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(
    entry,
    [
      `import { ${name} } from '@ultimat3/action';`,
      "import { UltimateError } from '@ultimat3/core';",
      `export const held = ${name};`,
      "export const title = new UltimateError({ code: 'X_INPUT_INVALID', cause: 'c', fix: 'f' }).title;",
      '',
    ].join('\n'),
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${name} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const code = await output.text();
  const chunk = join(FIXTURE_DIR, `${name}.chunk.js`);
  await Bun.write(chunk, code);
  const loaded: { readonly title?: unknown } = await import(chunk);
  const modules = code
    .split('\n')
    .filter((line) => line.startsWith('// ') && line.includes('packages/action/src/'))
    .map((line) => line.slice(line.indexOf('packages/action/src/') + 'packages/action/'.length));
  return { modules, title: loaded.title };
}

describe('a browser chunk that reaches the action barrel', () => {
  test('titles a remote action code with no class constructed — the titles module alone', async () => {
    // `inputSchemaName` constructs no error, so the title can only have come through the barrel.
    const { modules, title } = await island('inputSchemaName');
    expect(title).toBe(ACTION_ERROR_TITLES['X_INPUT_INVALID']);
    expect(modules).toContain('src/error-titles.ts');
    // The titles are their own module, so a chunk that constructs nothing carries none of the
    // classes. While the titles lived in `errors.ts` this chunk had to carry that module whole.
    expect(modules).not.toContain('src/errors.ts');
  }, 60_000);

  test('titles it on the typed client too, whose classes are there by use', async () => {
    // `rpc` is what `examples/dummy`'s `shared/browser-client.ts` imports: `client.ts` constructs
    // `RemoteActionError` and `ContractDriftError`, so `errors.ts` is in that chunk on purpose.
    const { modules, title } = await island('rpc');
    expect(title).toBe(ACTION_ERROR_TITLES['X_INPUT_INVALID']);
    expect(modules).toContain('src/error-titles.ts');
    expect(modules).toContain('src/errors.ts');
  }, 60_000);
});
