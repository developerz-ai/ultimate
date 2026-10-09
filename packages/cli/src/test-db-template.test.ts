// The migrated test-database template store: one tarball per migration state under the app root's
// `.x/test-db`, read whole or not at all, written atomically, and — the #738 half — writing a new
// state evicts the old ones down to the newest previous, so an app's `.x/test-db` stops at two
// files instead of one per migration it ever had (72 files, 4.2 GB, measured).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no directory listing, no utimes and no recursive remove.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import {
  readTemplate,
  TEST_DB_DIR,
  templateKey,
  templatePath,
  writeTemplate,
} from './test-db-template';

const scratch = mkdtempSync(join(tmpdir(), 'x-test-db-template-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function app(name: string): string {
  const root = join(scratch, name);
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  writeFileSync(join(root, 'app.config.ts'), 'export default {};\n');
  return root;
}

describe('templatePath', () => {
  test('under the app root’s .x/test-db, from the root or any folder below it', () => {
    const root = app('paths');
    const key = templateKey(['pglite 0.5.0', 'schema', 'migrations']);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(templatePath(root, key)).toBe(join(root, '.x', TEST_DB_DIR, `pglite-${key}.tar`));
    expect(templatePath(join(root, 'apps', 'web'), key)).toBe(templatePath(root, key));
  });

  test('any input that changes changes the key', () => {
    expect(templateKey(['a', 'b'])).not.toBe(templateKey(['a', 'c']));
    expect(templateKey(['ab', 'c'])).not.toBe(templateKey(['a', 'bc']));
  });
});

describe('readTemplate / writeTemplate', () => {
  test('what was written is read back whole; an absent template is a miss', async () => {
    const root = app('roundtrip');
    const path = templatePath(root, templateKey(['one']));
    expect(await readTemplate(path)).toBeUndefined();
    await writeTemplate(path, new Blob(['tarball']));
    expect(await (await readTemplate(path))?.text()).toBe('tarball');
  });

  test('a new migration state evicts all but the newest previous one, and no temp file is left', async () => {
    const root = app('evict');
    const dir = join(root, '.x', TEST_DB_DIR);
    const states = ['v1', 'v2', 'v3', 'v4'];
    for (const [index, state] of states.entries()) {
      const path = templatePath(root, templateKey([state]));
      await writeTemplate(path, new Blob([state]));
      // Distinct mtimes, oldest first, whatever the filesystem's resolution.
      const at = (Date.now() - (states.length - index) * 60_000) / 1000;
      utimesSync(path, at, at);
    }
    const current = templatePath(root, templateKey(['v5']));
    await writeTemplate(current, new Blob(['v5']));
    expect(readdirSync(dir).sort()).toEqual(
      [templatePath(root, templateKey(['v4'])), current].map((p) => p.slice(dir.length + 1)).sort(),
    );
  });

  test('a template deleted under a reader is a miss, never a throw', async () => {
    const root = app('raced');
    const path = templatePath(root, templateKey(['gone']));
    await writeTemplate(path, new Blob(['x']));
    rmSync(path);
    expect(await readTemplate(path)).toBeUndefined();
  });
});
