// The probe compiles a sheet "as though it were the file at `path`" — which only holds when the
// path becomes a file URL that still names that file. A string-built `file://${path}` did not for a
// directory holding `#` (the rest became a fragment) or for a Windows `D:\…` path.

import { afterAll, expect, test } from 'bun:test';
// why: Bun exposes no temp-directory primitive and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { compileScss, compileScssFile, compileSheets } from './sass-probe-fixture';

const scratch = mkdtempSync(join(tmpdir(), 'x-sass-probe-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('a relative @use resolves beside the file even when its directory holds a `#`', async () => {
  const dir = join(scratch, 'issue #12');
  await Bun.write(join(dir, '_tone.scss'), '$tone: teal;');
  const css = await compileScss('@use "tone"; a { color: tone.$tone; }', join(dir, 'main.scss'));
  expect(css).toContain('color: teal');
});

test('compileSheets answers each sheet as its own compile would, by name, loading a shared @use once', async () => {
  const dir = join(scratch, 'sheets');
  await Bun.write(join(dir, '_tone.scss'), '$tone: teal;');
  await Bun.write(join(dir, 'A.module.scss'), '@use "tone"; .a { color: tone.$tone; }');
  await Bun.write(join(dir, 'B.module.scss'), '@use "tone"; .b { border-color: tone.$tone; }');
  const sheets = await compileSheets(dir);
  expect([...sheets.keys()]).toEqual(['A.module.scss', 'B.module.scss']);
  // Blank lines between rules are the one difference a nested load emits; the rules are equal.
  const lines = (css: string) => css.split('\n').filter((line) => line.trim() !== '');
  for (const name of ['A.module.scss', 'B.module.scss']) {
    expect(lines(sheets.get(name) ?? '')).toEqual(lines(await compileScssFile(join(dir, name))));
  }
  expect(sheets.get('A.module.scss')).not.toContain('.b');
});
