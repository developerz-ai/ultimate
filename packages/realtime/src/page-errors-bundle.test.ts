// An island that reads one record must not carry realtime's whole code table. Measured on the
// artifact: `Bun.build` with `minify: false` writes one `// <path>` banner per retained module, so
// the retained SET is read off the chunk and a regression names its file — `errors.ts` (the table
// and its `registerErrorCodes()`) must be absent, and `page-errors.ts` (the refusals a browser can
// reach, titled from the table only where one was loaded) present in its place.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/realtime`
// resolves through the workspace, and each banner is resolved back to an absolute path.
import { join, resolve } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `page-errors-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

async function retained(hook: string): Promise<string[]> {
  const entry = join(FIXTURE_DIR, `${hook}.ts`);
  await Bun.write(
    entry,
    `import { ${hook} } from '@ultimat3/realtime';\nglobalThis.probe = ${hook};\n`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${hook} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const modules: string[] = [];
  for (const line of (await output.text()).split('\n')) {
    if (!line.startsWith('// ')) continue;
    const path = resolve(process.cwd(), line.slice(3));
    if (path.startsWith(`${PACKAGES}/`) && (await Bun.file(path).exists())) {
      modules.push(path.slice(PACKAGES.length + 1));
    }
  }
  return modules;
}

describe('the browser path to a record', () => {
  for (const hook of ['useRecord', 'useMutation']) {
    test(`${hook} retains the page refusals, never the code table`, async () => {
      const modules = await retained(hook);
      expect(modules).toContain('realtime/src/page-errors.ts');
      expect(modules).not.toContain('realtime/src/errors.ts');
    }, 60_000);
  }
});
