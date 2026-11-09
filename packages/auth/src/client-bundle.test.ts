// `@ultimat3/auth/client` is the browser entry, so its module graph is the claim: bundled for the
// browser, the retained set is `passkey-client.ts` and `base64url.ts` — never the
// server half (`@ultimat3/db`, argon2, the error table, `@ultimat3/core`) — and the chunk names no
// `node:` module. Read off the `// <path>` banners `Bun.build` writes, as `@ultimat3/pwa`'s does.

import { afterAll, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/auth/client`
// resolves through the workspace, and each banner is resolved back to a package-relative name.
import { join, relative, resolve, sep } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `client-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

const ENTRY = `import * as client from '@ultimat3/auth/client';
globalThis.probe = [client.newPasskey, client.getPasskey, client.passkeysSupported];
`;

test('the browser entry carries the passkey client and base64url, nothing of the server half', async () => {
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
  // `client.ts` re-exports only, so it writes no banner of its own.
  expect(modules.sort()).toEqual(['auth/src/base64url.ts', 'auth/src/passkey-client.ts']);
  expect(code).not.toContain('node:');
  // A measurement, not a ceiling to game: the whole browser half of a passkey ceremony.
  expect(code.length).toBeLessThan(8_000);
});
