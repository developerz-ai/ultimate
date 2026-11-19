// What a merge left, read off a real directory: the catalog is named, and its symptoms are not.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove API.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './app-load';
import type { Runner } from './exec';
import {
  CATALOG_ROOT,
  catalogFileFindings,
  unmergedFindings,
  withMergeCauses,
} from './merge-state';
import type { Finding } from './output';
import { CATALOG_ROOT as TEMPLATE_CATALOG_ROOT } from './templates/locales';

const EN = 'packages/i18n/catalogs/en.json';
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'merge-state-'));
  mkdirSync(join(root, 'packages/i18n/catalogs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const catalog = (text: string): void => writeFileSync(join(root, EN), text);

const answering =
  (code: number, stdout: string): Runner =>
  async (command) => ({
    command,
    code,
    ok: code === 0,
    stdout,
    stderr: '',
    durationMs: 0,
  });

describe('unit · catalogFileFindings', () => {
  test('reads the directory the templates write catalogs to', () => {
    expect(CATALOG_ROOT).toBe(TEMPLATE_CATALOG_ROOT);
  });

  test('an app with no catalog directory has nothing to report', async () => {
    rmSync(join(root, 'packages'), { recursive: true });
    expect(await catalogFileFindings(root)).toEqual([]);
  });

  test('a valid catalog is silent', async () => {
    catalog('{"a":"b"}\n');
    expect(await catalogFileFindings(root)).toEqual([]);
  });

  test('a conflict marker is X_MERGE_UNRESOLVED, at the file, with a fix naming it', async () => {
    catalog('<<<<<<< HEAD\n{}\n');
    const [found] = await catalogFileFindings(root);
    expect(found?.code).toBe('X_MERGE_UNRESOLVED');
    expect(found?.at).toBe(EN);
    expect(found?.fix).toContain(EN);
    expect(found?.fix).not.toContain('x doctor');
  });

  test('anything else malformed is X_CATALOG_UNPARSEABLE, naming the file', async () => {
    catalog('{ "broken": \n');
    const [found] = await catalogFileFindings(root);
    expect(found?.code).toBe('X_CATALOG_UNPARSEABLE');
    expect(found?.at).toBe(EN);
    expect(found?.fix).toBe(`bunx biome check ${EN}   # names the line to correct`);
  });
});

describe('unit · unmergedFindings', () => {
  test('one finding per path git holds unmerged', async () => {
    const found = await unmergedFindings(root, answering(0, 'a.ts\nb.ts\n'));
    expect(found.map((one) => [one.code, one.at])).toEqual([
      ['X_MERGE_UNRESOLVED', 'a.ts'],
      ['X_MERGE_UNRESOLVED', 'b.ts'],
    ]);
  });

  test('outside a checkout there is nothing to report', async () => {
    expect(await unmergedFindings(root, answering(128, ''))).toEqual([]);
  });
});

describe('unit · withMergeCauses', () => {
  const symptom = (at: string): Finding => ({
    code: 'X_CLI_UNEXPECTED',
    cause: "SyntaxError: JSON Parse error: Unrecognized token '<'",
    fix: 'x doctor --json',
    at,
  });
  const other: Finding = { code: 'X_OTHER', cause: 'unrelated', fix: 'x help', at: 'z.ts' };

  test('a broken catalog replaces the parse errors of its importers, and nothing else', async () => {
    catalog('<<<<<<< HEAD\n');
    const found = await withMergeCauses(root, [symptom('a.tsx'), symptom('b.tsx'), other]);
    expect(found.map((one) => one.code)).toEqual(['X_MERGE_UNRESOLVED', 'X_OTHER']);
    expect(found[0]?.at).toBe(EN);
  });

  test('a healthy catalog leaves the load findings as they were', async () => {
    catalog('{}\n');
    expect(await withMergeCauses(root, [symptom('a.tsx')])).toEqual([symptom('a.tsx')]);
  });
});

describe('unit · loadApp over a catalog a merge broke', () => {
  test('names the catalog instead of the module that imported it', async () => {
    catalog('<<<<<<< HEAD\n{}\n');
    writeFileSync(join(root, 'app.config.ts'), 'export default {};\n');
    mkdirSync(join(root, 'apps/web/api'), { recursive: true });
    writeFileSync(
      join(root, 'apps/web/api/uses-catalog.ts'),
      `import en from '../../../${EN}';\nexport const size = Object.keys(en).length;\n`,
    );
    const { findings } = await loadApp(root);
    expect(findings[0]?.code).toBe('X_MERGE_UNRESOLVED');
    expect(findings[0]?.at).toBe(EN);
    expect(findings.some((one) => one.at === 'apps/web/api/uses-catalog.ts')).toBe(false);
  });
});
