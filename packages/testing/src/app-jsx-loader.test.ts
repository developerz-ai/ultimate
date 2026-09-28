// The JSX loader is installed up front only where `defineCatalogs()`-style app modules live: an app.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { installAppJsxLoader, isAppRoot } from './app-jsx-loader';

const dir = mkdtempSync(join(tmpdir(), 'x-jsx-loader-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('unit · app JSX loader', () => {
  test('outside an app nothing is installed', async () => {
    expect(isAppRoot(dir)).toBe(false);
    expect(await installAppJsxLoader(dir)).toBe(false);
  });

  test('in an app root the render loader is installed', async () => {
    writeFileSync(join(dir, 'app.config.ts'), 'export const config = {};\n');
    expect(isAppRoot(dir)).toBe(true);
    expect(await installAppJsxLoader(dir)).toBe(true);
  });
});
