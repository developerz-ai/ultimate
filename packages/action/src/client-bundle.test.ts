// The browser `rpc` chunk, built on the Bun that ships and read off the artifact. `client.ts` and
// the error modules it reaches import core through `@ultimat3/core/page` only: no core titles
// table, no `node:` module. Through the island's real import, the action barrel, it also builds
// with no warning, and its size is pinned — a measurement: real function that costs bytes raises
// it, with the number and the reason.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/action`
// resolves through the workspace exactly as an island's import does.
import { join } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `client-bundle-${process.pid}`);

/** Measured 2026-11-09, Bun 1.4.4: 24,473 B minified (29,972 B while it read the core barrel). */
const RPC_MINIFIED_BYTES_MAX = 25_000;

/** The client module itself, and what an island writes. */
const CLIENT_MODULE = join(import.meta.dir, 'client.ts');
const BARREL = '@ultimat3/action';

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

interface Chunk {
  readonly code: string;
  readonly logs: readonly string[];
  readonly modules: readonly string[];
}

async function build(specifier: string, minify: boolean): Promise<Chunk> {
  const entry = join(FIXTURE_DIR, `rpc-${specifier === BARREL ? 'barrel' : 'module'}-${minify}.ts`);
  await Bun.write(
    entry,
    `import { rpc } from ${JSON.stringify(specifier)};\nglobalThis.probe = rpc({ baseUrl: '/' });\n`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`rpc did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const code = await output.text();
  const modules = code
    .split('\n')
    .filter((line) => line.startsWith('// ') && line.includes('packages/'))
    .map((line) => line.slice(line.indexOf('packages/')).replaceAll('\\', '/'));
  return { code, logs: built.logs.map(String), modules };
}

describe('the browser rpc chunk', () => {
  test('builds from client.ts with no warning and names no node: module', async () => {
    const { code, logs } = await build(CLIENT_MODULE, false);
    expect(logs).toEqual([]);
    expect(code).not.toMatch(/["']node:/);
  }, 60_000);

  // The action barrel's server modules still import core's barrel, which reaches `png-pixels.ts`.
  // A static `node:zlib` import there warned in every browser build of `@ultimat3/action`.
  test('through the barrel, builds with no warning and names no node: module', async () => {
    const { code, logs } = await build(BARREL, false);
    expect(logs).toEqual([]);
    expect(code).not.toMatch(/["']node:/);
  }, 60_000);

  test('through the barrel, retains no core titles table and no image module', async () => {
    const { modules } = await build(BARREL, false);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules).not.toContain('packages/core/src/core-error-codes.ts');
    expect(modules).not.toContain('packages/core/src/schema-error-codes.ts');
    expect(modules.filter((module) => module.includes('/image/'))).toEqual([]);
  }, 60_000);

  test(`through the barrel, is at most ${RPC_MINIFIED_BYTES_MAX} bytes minified`, async () => {
    const { code } = await build(BARREL, true);
    expect(code.length).toBeLessThanOrEqual(RPC_MINIFIED_BYTES_MAX);
  }, 60_000);
});
