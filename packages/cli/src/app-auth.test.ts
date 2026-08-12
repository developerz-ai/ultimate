import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    await writeConfig("export const config = { auth: { signInPath: '/signin' } };\n");
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
  // typo or an off-site destination, and both are worse than the problem document it replaces.
  test('anything that is not a rooted path is refused', async () => {
    await writeConfig("export const config = { auth: { signInPath: 'https://evil.test' } };\n");
    expect(await loadSignInPath(root)).toBeNull();
  });
});
