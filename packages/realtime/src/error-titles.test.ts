// A browser chunk that reaches the realtime barrel renders every realtime code's TITLE —
// `refusalError` rebuilds a sync node's refusal by code, and `page-errors.ts` constructs codes this
// package registers without importing the table — and carries `errors.ts` (the sync node's
// refusal classes) nowhere a browser can reach. Built, run and read off the artifact.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/realtime`
// resolves through the workspace exactly as an island's import does.
import { join } from 'node:path';
import { REALTIME_ERROR_TITLES } from './error-titles';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `error-titles-${process.pid}`);

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

/** Bundles `body` (which imports from the barrel and exports `title`), runs it, reads the chunk. */
async function island(
  name: string,
  body: readonly string[],
): Promise<{
  readonly modules: readonly string[];
  readonly title: unknown;
  readonly delayMs: unknown;
  readonly code: string;
}> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, [...body, ''].join('\n'));
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${name} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const code = await output.text();
  const chunk = join(FIXTURE_DIR, `${name}.chunk.js`);
  await Bun.write(chunk, code);
  const loaded: { readonly title?: unknown; readonly delayMs?: unknown } = await import(chunk);
  const modules = code
    .split('\n')
    .filter((line) => line.startsWith('// ') && line.includes('packages/realtime/src/'))
    .map((line) =>
      line.slice(line.indexOf('packages/realtime/src/') + 'packages/realtime/'.length),
    );
  return { modules, title: loaded.title, delayMs: loaded.delayMs, code };
}

describe('a browser chunk that reaches the realtime barrel', () => {
  test("titles a sync node's refusal with nothing constructed — the titles module alone", async () => {
    // `applyPatches` constructs no error, so the title can only have come through the barrel.
    const { modules, title } = await island('remote', [
      "import { applyPatches } from '@ultimat3/realtime';",
      "import { UltimateError } from '@ultimat3/core';",
      'export const held = applyPatches;',
      "export const title = new UltimateError({ code: 'X_CURSOR_STALE', cause: 'c', fix: 'f' }).title;",
    ]);
    expect(title).toBe(REALTIME_ERROR_TITLES.X_CURSOR_STALE);
    expect(modules).toContain('src/error-titles.ts');
    // Listed in `sideEffects`, the sync node's refusal classes rode into every island.
    expect(modules).not.toContain('src/errors.ts');
  }, 60_000);

  test("titles a write's HTTP-layer refusal off the body and waits its Retry-After", async () => {
    // `useMutation` POSTs through core's page `clientTransport` with no decoder of its own, so a
    // 429 from `@ultimat3/http` meets `problemError` in a chunk that loads no http module.
    const { code, title, delayMs } = await island('write', [
      "import { applyPatches } from '@ultimat3/realtime';",
      "import { clientTransport } from '@ultimat3/core/page';",
      "import { retryDecision } from '@ultimat3/core';",
      'export const held = applyPatches;',
      "const body = JSON.stringify({ code: 'X_RATE_LIMITED', title: 'rate limit exhausted for this key', cause: 'c', fix: 'f' });",
      "const fetchImpl = async () => new Response(body, { status: 429, headers: { 'retry-after': '2' } });",
      "const refused = await clientTransport({ method: 'POST', url: '/x', fetchImpl }).catch((e) => e);",
      'export const title = refused.title;',
      "export const delayMs = retryDecision({ attempts: 3, base: 50, max: 60_000, factor: 2, curve: 'exponential' }, 1, refused, () => 0).delayMs;",
    ]);
    expect(title).toBe('rate limit exhausted for this key');
    expect(delayMs).toBe(2_000);
    expect(code.includes('packages/http/'), 'an http module in the chunk').toBe(false);
  }, 60_000);

  test('titles a page refusal, which page-errors.ts constructs without importing the table', async () => {
    const { modules, title } = await island('page', [
      "import { RealtimeUninstalledError } from '@ultimat3/realtime';",
      "export const title = new RealtimeUninstalledError({ hook: 'useRecord' }).title;",
    ]);
    // The class is named through the barrel's re-export from `errors.ts`, so this chunk is not the
    // place to judge that module's absence — a hook's chunk is, in `page-errors-bundle.test.ts`.
    expect(title).toBe(REALTIME_ERROR_TITLES.X_REALTIME_UNINSTALLED);
    expect(modules).toContain('src/page-errors.ts');
  }, 60_000);
});
