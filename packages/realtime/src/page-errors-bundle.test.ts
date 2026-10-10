// An island that reads one record must not carry realtime's whole code table. Measured on the
// artifact: `Bun.build` with `minify: false` writes one `// <path>` banner per retained module, so
// the retained SET is read off the chunk and a regression names its file — `errors.ts` (the sync
// node's refusal classes) must be absent, and `page-errors.ts` (the refusals a browser can reach,
// titled through `error-titles.ts`, which the barrel imports bare) present in its place.

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

async function chunk(hook: string, minify: boolean): Promise<string> {
  const entry = join(FIXTURE_DIR, `${hook}.ts`);
  await Bun.write(
    entry,
    `import { ${hook} } from '@ultimat3/realtime';\nglobalThis.probe = ${hook};\n`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${hook} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  return output.text();
}

async function retained(hook: string): Promise<string[]> {
  const modules: string[] = [];
  for (const line of (await chunk(hook, false)).split('\n')) {
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

// The barrel's one side effect is `error-titles.ts`, in every chunk that reaches it. It registered
// through `@ultimat3/core`'s BARREL, whose own anchors are core's and schema's titles tables — so
// an island that only follows a channel carried two tables it never reads beside the one it does.
// Measured 2026-10-10, Bun 1.4.2, `minify: true`, an island whose whole body is `useChannel`:
// 12,692 B (5,407 gzip) → 8,121 B (3,658 gzip) with the registration through `@ultimat3/core/page`.
describe('what reaching the barrel costs an island that only follows a channel', () => {
  test('realtime titles its own codes, and brings no other package table', async () => {
    const modules = await retained('useChannel');
    expect(modules).toContain('realtime/src/error-titles.ts');
    expect(modules).toContain('realtime/src/use-channel.ts');
    expect(modules).not.toContain('core/src/core-error-codes.ts');
    expect(modules).not.toContain('core/src/schema-error-codes.ts');
    expect(modules).not.toContain('schema/src/error-codes.ts');
    // Nothing of the record store, the outbox or the first-paint wait either.
    expect(modules.filter((module) => /record-|outbox|first-paint/.test(module))).toEqual([]);
  }, 60_000);

  test('the measured size holds', async () => {
    const bytes = new TextEncoder().encode(await chunk('useChannel', true)).byteLength;
    // 8,121 B when measured; the ceiling is the measurement plus headroom for a reworded title.
    expect(bytes).toBeLessThan(8_600);
  }, 60_000);
});
