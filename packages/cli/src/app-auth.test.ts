import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { loadSignInPath } from './app-auth';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-app-auth-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A fresh path per test: `import()` caches by resolved specifier for the life of the process, so
// two configs written to the same filename would hand the second test the first one's exports.
const writeConfig = (body: string) => Bun.write(join(root, 'app.config.ts'), body);

describe('unit · where the app says its sign-in page is', () => {
  test('the declared path', async () => {
    await writeConfig("export const config = { name: 'demo', auth: { signInPath: '/signin' } };\n");
    expect(await loadSignInPath(root)).toBe('/signin');
  });

  test('an app that declares no auth section turns the redirect off', async () => {
    await writeConfig("export const config = { name: 'demo' };\n");
    expect(await loadSignInPath(root)).toBeNull();
  });

  test('a directory with no app.config.ts is not an error', async () => {
    expect(await loadSignInPath(root)).toBeNull();
  });

  // `signInPath` becomes a `Location:` header. A value that is not a rooted path is either a
  // typo or an off-site destination: refused by core's validator through the one loader, where it
  // used to read as "no redirect" and boot.
  test('anything that is not a rooted path is refused', async () => {
    await writeConfig(
      "export const config = { name: 'demo', auth: { signInPath: 'https://evil.test' } };\n",
    );
    const error: unknown = await loadSignInPath(root).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isUltimateError(error) ? error.code : 'not coded').toBe('X_CONFIG_INVALID');
  });
});
