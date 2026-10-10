// `@ultimat3/render/client` is the browser entry, so its module graph is the claim: bundled for the
// browser, the retained set is the navigation helpers, the modal refusal and `@ultimat3/core/page`'s
// graph — never `errors.ts` (render's code table, registered at import, which the `.` barrel's
// `sideEffects` keeps in every chunk that reaches it), never core's titles tables, never a `node:`
// module. Read off the `// <path>` banners `Bun.build` writes per retained module with
// `minify: false`, as `packages/pwa/src/client-bundle.test.ts` does, so a regression names its file.
//
// Measured 2026-10-08, Bun 1.4.2, `minify: true`, an island whose whole body is `refresh`:
// 9,323 B through `@ultimat3/render` (errors.ts + core's and schema's tables) → 216 B through
// `@ultimat3/render/client` (`navigation-api.ts` alone).

import { afterAll, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/render/client`
// resolves through the workspace, and each banner is resolved back to a package-relative name.
import { join, relative, resolve, sep } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `client-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

/** Every value the entry exports, used, so nothing is shaken out before it is weighed. */
const EVERY_EXPORT = `import * as client from '@ultimat3/render/client';
globalThis.probe = [
  client.navigate,
  client.refresh,
  client.openModal,
  client.closeModal,
  client.NavigationModalPathInvalidError,
  client.NAVIGATE_EVENT,
  client.NAVIGATED_EVENT,
  client.NAVIGATION_ERROR_EVENT,
  client.disposeIslands,
];
`;

/** The island the consuming app measured: it calls `refresh()` after a write, and nothing else. */
const REFRESH_ONLY = `import { refresh } from '@ultimat3/render/client';
globalThis.probe = refresh;
`;

interface Bundle {
  readonly code: string;
  readonly modules: readonly string[];
}

async function bundle(name: string, source: string, minify = false): Promise<Bundle> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${name} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const code = await output.text();
  const modules: string[] = [];
  for (const line of code.split('\n')) {
    if (!line.startsWith('// ')) continue;
    const inside = relative(PACKAGES, resolve(process.cwd(), line.slice(3)));
    if (inside.startsWith('..') || !inside.includes(`${sep}src${sep}`)) continue;
    modules.push(inside.split(sep).join('/'));
  }
  return { code, modules: modules.sort() };
}

test('the browser entry carries the navigation helpers and core/page, never the code tables', async () => {
  const { code, modules } = await bundle('every-export', EVERY_EXPORT);
  const render = modules.filter((module) => module.startsWith('render/'));
  // `client.ts` is re-exports only, so it writes no banner of its own.
  expect(render).toEqual([
    'render/src/island-dispose.ts',
    'render/src/navigation-api.ts',
    'render/src/navigation-errors.ts',
    'render/src/navigation-modal-rules.ts',
    'render/src/navigation-rules.ts',
  ]);
  // Anything else is `UltimateError`'s graph through `@ultimat3/core/page` — no titles table.
  for (const module of modules.filter((m) => !m.startsWith('render/'))) {
    expect(module.startsWith('core/src/') || module.startsWith('schema/src/')).toBe(true);
  }
  expect(modules).not.toContain('core/src/core-error-codes.ts');
  expect(modules).not.toContain('core/src/schema-error-codes.ts');
  expect(modules).not.toContain('schema/src/error-codes.ts');
  expect(code).not.toMatch(/from\s*["']node:|require\(["']node:/);
});

test('an island that only refreshes carries navigation-api.ts and nothing else', async () => {
  expect((await bundle('refresh-only', REFRESH_ONLY)).modules).toEqual([
    'render/src/navigation-api.ts',
  ]);
  // 216 B when measured; through the `.` barrel the same island was 9,323 B.
  const minified = await bundle('refresh-only-min', REFRESH_ONLY, true);
  expect(new TextEncoder().encode(minified.code).byteLength).toBeLessThan(1024);
});

test('an island that only releases nested islands carries island-dispose.ts and nothing else', async () => {
  const source =
    "import { disposeIslands } from '@ultimat3/render/client';\nglobalThis.probe = disposeIslands;\n";
  expect((await bundle('dispose-only', source)).modules).toEqual(['render/src/island-dispose.ts']);
  // 296 B when measured (2026-10-10, Bun 1.4.2, `minify: true`).
  const minified = await bundle('dispose-only-min', source, true);
  expect(new TextEncoder().encode(minified.code).byteLength).toBeLessThan(512);
});

test('openModal still rejects with the stable code, as the one class both entries export', async () => {
  const client = await import('@ultimat3/render/client');
  const barrel = await import('@ultimat3/render');
  expect(client.NavigationModalPathInvalidError).toBe(barrel.NavigationModalPathInvalidError);
  const refused = await client.openModal('https://elsewhere.test/x').then(
    () => expect.unreachable('a cross-origin modal path was accepted'),
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(barrel.NavigationModalPathInvalidError);
  expect((refused as { code: string }).code).toBe('X_NAVIGATION_MODAL_PATH_INVALID');
});
