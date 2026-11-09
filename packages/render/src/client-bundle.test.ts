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
  client.NAVIGATION_MODAL_ATTRIBUTE,
  client.disposeIslands,
  client.scheduleRefresh,
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
    'render/src/refresh-idle.ts',
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

// Plan 101 slice 14 P4: an adopter measured `navigate()` pulling core's error registry (8,959 B)
// into islands that import nothing else of core. The pin is on the TITLES: no code table at all.
test('an island that only navigates carries no error-code table and no core titles', async () => {
  const source =
    "import { navigate } from '@ultimat3/render/client';\nglobalThis.probe = navigate;\n";
  const { code, modules } = await bundle('navigate-only', source);
  expect(modules).not.toContain('render/src/errors.ts');
  expect(modules).not.toContain('core/src/core-error-codes.ts');
  expect(modules).not.toContain('core/src/schema-error-codes.ts');
  expect(modules).not.toContain('schema/src/error-codes.ts');
  // A title core registers for one of its own codes: present only if a table came along.
  expect(code).not.toContain('error code registered twice');
});

// An adopter restated `dialog[data-x-modal]` because the attribute was not on the browser entry.
test('the browser entry names the modal attribute, as the same constant the router writes', async () => {
  const client = await import('@ultimat3/render/client');
  const rules = await import('./navigation-modal-rules');
  expect(client.NAVIGATION_MODAL_ATTRIBUTE).toBe(rules.NAVIGATION_MODAL_ATTRIBUTE);
  expect(client.NAVIGATION_MODAL_ATTRIBUTE).toBe('data-x-modal');
});

test('an island that only releases nested islands carries island-dispose.ts and nothing else', async () => {
  const source =
    "import { disposeIslands } from '@ultimat3/render/client';\nglobalThis.probe = disposeIslands;\n";
  expect((await bundle('dispose-only', source)).modules).toEqual(['render/src/island-dispose.ts']);
  // 296 B when measured (2026-10-10, Bun 1.4.2, `minify: true`).
  const minified = await bundle('dispose-only-min', source, true);
  expect(new TextEncoder().encode(minified.code).byteLength).toBeLessThan(512);
});

test('an island that schedules refreshes carries refresh-idle.ts and the session flag, no router', async () => {
  const source =
    "import { scheduleRefresh } from '@ultimat3/render/client';\nglobalThis.probe = scheduleRefresh;\n";
  const { modules } = await bundle('schedule-only', source);
  expect(modules.filter((module) => module.startsWith('render/'))).toEqual([
    'render/src/refresh-idle.ts',
  ]);
  expect(modules).not.toContain('core/src/errors.ts');
  // 3,079 B when measured (2026-11-05, Bun 1.4.4, `minify: true`): the scheduler, `systemClock`
  // and the page handle's session cell. The ceiling keeps half a kilobyte of headroom.
  const minified = await bundle('schedule-only-min', source, true);
  expect(new TextEncoder().encode(minified.code).byteLength).toBeLessThan(3_584);
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
