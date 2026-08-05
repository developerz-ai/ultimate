import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkFileSizes,
  checkPackageShape,
  hasWorkspacePackages,
  LINE_CEILING,
  PACKAGE_FILES,
  workspacePackages,
} from './workspace-checks';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

let dir = '';

const lines = (count: number): string =>
  Array.from({ length: count }, () => 'const x = 1;').join('\n');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-workspace-checks-'));
  await Bun.write(join(dir, 'packages/short/src/index.ts'), lines(LINE_CEILING));
  await Bun.write(join(dir, 'packages/short/README.md'), '# short\n');
  await Bun.write(join(dir, 'packages/short/CLAUDE.md'), '# short\n');
  await Bun.write(join(dir, 'packages/short/tsconfig.json'), '{}\n');
  await Bun.write(join(dir, 'packages/short/package.json'), '{"name":"short"}\n');
  await Bun.write(join(dir, 'packages/long/src/index.ts'), lines(LINE_CEILING + 1));
  await Bun.write(join(dir, 'packages/long/package.json'), '{"name":"long"}\n');
  await Bun.write(join(dir, 'packages/long/node_modules/dep/src/huge.ts'), lines(2_000));
  await Bun.write(join(dir, 'app/orgs/page.tsx'), lines(LINE_CEILING + 40));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('unit · the file-size ceiling', () => {
  test('one line over the ceiling is a finding, exactly at it is not', async () => {
    const findings = await checkFileSizes(dir);
    const paths = findings.map((finding) => finding.at);
    expect(paths).toContain('packages/long/src/index.ts');
    expect(paths).not.toContain('packages/short/src/index.ts');
    expect(findings.every((finding) => finding.code === 'X_FILE_TOO_LONG')).toBe(true);
  });

  test('app surfaces are scanned too, and dependencies are not', async () => {
    const paths = (await checkFileSizes(dir)).map((finding) => finding.at);
    expect(paths).toContain('app/orgs/page.tsx');
    expect(paths.some((path) => path?.includes('node_modules'))).toBe(false);
  });

  test('every finding names the file it is about in its fix', async () => {
    for (const finding of await checkFileSizes(dir)) {
      expect(finding.fix).toContain(finding.at ?? '');
    }
  });
});

describe('unit · the package shape', () => {
  test('a package missing a contract file is reported once per file', async () => {
    const findings = await checkPackageShape(dir);
    expect(findings.map((finding) => finding.at)).toEqual([
      'packages/long/README.md',
      'packages/long/CLAUDE.md',
      'packages/long/tsconfig.json',
    ]);
    expect(findings.every((finding) => finding.code === 'X_PACKAGE_SHAPE')).toBe(true);
  });

  test('this repo satisfies the shape it enforces', async () => {
    expect(await checkPackageShape(REPO_ROOT)).toEqual([]);
    expect(await workspacePackages(REPO_ROOT)).toContain('cli');
    expect(PACKAGE_FILES).toHaveLength(4);
  });

  test('the step is skipped where there are no workspace packages', async () => {
    expect(await hasWorkspacePackages(dir)).toBe(true);
    expect(await hasWorkspacePackages(join(dir, 'app'))).toBe(false);
  });
});
