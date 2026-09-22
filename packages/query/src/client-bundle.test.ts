// The browser read client is what every island with a `useQuery` carries; it must not carry an
// error-titles TABLE — core's own, schema's, or this package's (`errors.ts` registers the whole
// code table at import). Measured on the artifact: `Bun.build` with `minify: false` writes one
// `// <path>` banner per retained module, so the retained SET is read off the chunk and a
// regression names its file.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/*` resolves
// through the workspace, and each banner is resolved back to an absolute path.
import { join, resolve } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `client-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

async function build(minify: boolean): Promise<{ modules: string[]; bytes: number }> {
  const entry = join(FIXTURE_DIR, `client-${minify ? 'min' : 'banners'}.ts`);
  await Bun.write(
    entry,
    "import { queryClient } from '@ultimat3/query/client';\nglobalThis.probe = queryClient;\n",
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`the client did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const modules: string[] = [];
  for (const line of (await output.text()).split('\n')) {
    if (!line.startsWith('// ')) continue;
    const path = resolve(process.cwd(), line.slice(3));
    if (path.startsWith(`${PACKAGES}/`) && (await Bun.file(path).exists())) {
      modules.push(path.slice(PACKAGES.length + 1));
    }
  }
  return { modules: modules.sort(), bytes: output.size };
}

const isTitlesTable = (module: string): boolean =>
  module === 'core/src/core-error-codes.ts' ||
  module === 'core/src/schema-error-codes.ts' ||
  module === 'query/src/errors.ts' ||
  module.startsWith('schema/src/');

describe('@ultimat3/query/client in a browser', () => {
  test('reaches no titles table', async () => {
    const { modules } = await build(false);
    expect(modules).toContain('query/src/client.ts');
    expect(modules.filter(isTitlesTable)).toEqual([]);
  }, 60_000);

  test('stays under 11 kB minified (10,210 B as of 2026-09-22)', async () => {
    const { bytes } = await build(true);
    expect(bytes).toBeLessThan(11_264);
  }, 60_000);
});
