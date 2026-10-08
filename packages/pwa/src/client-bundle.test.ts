// `@ultimat3/pwa/client` is the browser entry, so its module graph is the claim: bundled for the
// browser, the retained set is the three client modules and `@ultimat3/core/page`'s graph — never the
// icon pipeline (core's image transform is Node-only), the service-worker generator, the push
// sender or this package's error table — and the chunk names no `node:` module. Read off the
// `// <path>` banners `Bun.build` writes per retained module with `minify: false`, as
// `packages/core/src/page-bundle.test.ts` does, so a regression names its file.

import { afterAll, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/pwa/client`
// resolves through the workspace, and each banner is resolved back to a package-relative name.
import { join, relative, resolve, sep } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `client-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

/** Every value the entry exports, used, so nothing is shaken out before it is weighed. */
const ENTRY = `import * as client from '@ultimat3/pwa/client';
globalThis.probe = [
  client.installController,
  client.iosInstallGuidance,
  client.MIN_ENGAGEMENT_MS,
  client.detectSkew,
  client.subscribeToPush,
  client.unsubscribeFromPush,
  client.pushPermission,
  client.browserPushHost,
  client.PUSH_KEY_META,
];
`;

async function bundle(): Promise<{ code: string; modules: string[] }> {
  const entry = join(FIXTURE_DIR, 'entry.ts');
  await Bun.write(entry, ENTRY);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(
      `the client entry did not bundle: ${built.logs.map(String).join('; ')}`,
    );
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

test('the browser entry carries the client files and core/page, nothing of the server half', async () => {
  const { code, modules } = await bundle();
  const pwa = modules.filter((module) => module.startsWith('pwa/'));
  // `client.ts` is re-exports only, so it writes no banner of its own.
  expect(pwa).toEqual(['pwa/src/install.ts', 'pwa/src/push-client.ts', 'pwa/src/skew.ts']);
  // Anything else is core's browser subpath; the image pipeline and the barrel's tables are not.
  for (const module of modules.filter((m) => !m.startsWith('pwa/'))) {
    expect(module.startsWith('core/src/') || module.startsWith('schema/src/')).toBe(true);
  }
  expect(modules.filter((module) => module.startsWith('core/src/image/'))).toEqual([]);
  expect(modules).not.toContain('core/src/core-error-codes.ts');
  expect(code).not.toMatch(/from\s*["']node:|require\(["']node:/);
});
