// An app root is a directory holding `app.config.ts`, and nothing else is.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { isAppRoot } from './app-root';

const dir = mkdtempSync(join(tmpdir(), 'x-app-root-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('unit · app root', () => {
  test('a directory without app.config.ts is not an app', () => {
    expect(isAppRoot(dir)).toBe(false);
  });

  test('a directory with app.config.ts is an app', () => {
    writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
    expect(isAppRoot(dir)).toBe(true);
  });
});
