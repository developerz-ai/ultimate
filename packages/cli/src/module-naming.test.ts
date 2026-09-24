// The filename says where a module runs: `role-*` and `runtime-*` are booted by `serve.ts` in
// production, `dev-*` by `x dev` alone. Derived from the import graph rather than listed, so a
// production module named `dev-*` — or a dev-only one named `runtime-*` — is a failing test.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path API; `join` reaches each module from this directory.
import { join } from 'node:path';

const DIR = import.meta.dir;
const isSource = (file: string): boolean => /\.tsx?$/.test(file) && !file.includes('.test.');

/** Every module `serve*.ts` reaches through STATIC value imports — what a container evaluates. */
async function productionClosure(): Promise<ReadonlySet<string>> {
  const all = new Set<string>();
  for await (const file of new Bun.Glob('*.{ts,tsx}').scan({ cwd: DIR })) {
    if (isSource(file)) all.add(file);
  }
  const seen = new Set<string>();
  const stack = [...all].filter((file) => file.startsWith('serve'));
  while (stack.length > 0) {
    const file = stack.pop() ?? '';
    if (seen.has(file)) continue;
    seen.add(file);
    const loader = file.endsWith('x') ? 'tsx' : 'ts';
    const imports = new Bun.Transpiler({ loader }).scanImports(
      await Bun.file(join(DIR, file)).text(),
    );
    for (const entry of imports) {
      if (entry.kind !== 'import-statement' || !entry.path.startsWith('./')) continue;
      const base = entry.path.slice(2);
      const found = [`${base}.ts`, `${base}.tsx`].find((candidate) => all.has(candidate));
      if (found !== undefined) stack.push(found);
    }
  }
  return seen;
}

describe('unit · a module name says where it runs', () => {
  test('production reaches no dev-* module, and every role-* / runtime-* module is production', async () => {
    const production = await productionClosure();
    const named = async (prefix: RegExp): Promise<readonly string[]> => {
      const files: string[] = [];
      for await (const file of new Bun.Glob('*.{ts,tsx}').scan({ cwd: DIR })) {
        if (isSource(file) && prefix.test(file) && !file.includes('fixture')) files.push(file);
      }
      return files.sort();
    };
    expect([...production].filter((file) => file.startsWith('dev-')).sort()).toEqual([]);
    // A types-only module (`runtime-overrides.ts`) is erased from the value graph and is still
    // production's shape: named by an `import type` from a production module, it counts.
    const typeNamed = new Set<string>();
    for (const file of production) {
      const source = await Bun.file(join(DIR, file)).text();
      for (const match of source.matchAll(/from '\.\/([\w-]+)'/g)) typeNamed.add(`${match[1]}.ts`);
    }
    const stray = (await named(/^(role|runtime)-/)).filter(
      (file) => !production.has(file) && !typeNamed.has(file),
    );
    expect(stray).toEqual([]);
  });
});
