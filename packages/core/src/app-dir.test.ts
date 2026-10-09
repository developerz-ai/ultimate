// Every path under `.x/` hangs off the APP ROOT, never the process's cwd: a `bun test` started in a
// source folder wrote `.x/cache` directories beside the code (#738). `appDirOf` is the one walk.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { APP_CONFIG_FILE, appDirOf, appStatePath } from './app-dir';

const scratch = mkdtempSync(join(tmpdir(), 'x-app-dir-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const app = join(scratch, 'app');
const nested = join(app, 'apps', 'web', 'app', 'casos', '[id]', 'notificar');
mkdirSync(nested, { recursive: true });
writeFileSync(join(app, APP_CONFIG_FILE), 'export default {};\n');

describe('appDirOf', () => {
  test('the app root from the root itself and from any folder below it', () => {
    expect(appDirOf(app)).toBe(app);
    expect(appDirOf(nested)).toBe(app);
  });

  test('undefined outside an app', () => {
    expect(appDirOf(scratch)).toBeUndefined();
  });
});

describe('appStatePath', () => {
  test('`.x/<parts>` under the app root, whichever folder the process started in', () => {
    expect(appStatePath(nested, 'cache', 'sass')).toBe(join(app, '.x', 'cache', 'sass'));
    expect(appStatePath(app, 'test-db')).toBe(join(app, '.x', 'test-db'));
  });

  test('outside an app, the folder itself — there is no root to anchor to', () => {
    expect(appStatePath(scratch, 'cache')).toBe(join(scratch, '.x', 'cache'));
  });
});
