// Two shape rules the gate owns: one file, one job (a hard line ceiling), and every workspace
// package shipping the same contract files. Both report findings — a shape rule that is only
// written down is not a rule (axiom 3).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './output';

export const LINE_CEILING = 500;

export const PACKAGE_FILES = ['README.md', 'CLAUDE.md', 'tsconfig.json', 'src/index.ts'] as const;

/**
 * Where source lives in both shapes this gate runs against: a package monorepo and an app. A
 * nested example app under `examples/` is not scanned — it runs this same gate from its own root.
 */
const SOURCE_GLOBS = [
  'packages/*/src/**/*.{ts,tsx}',
  'scripts/**/*.{ts,tsx}',
  'site/**/*.{ts,tsx}',
  'app/**/*.{ts,tsx}',
  'api/**/*.{ts,tsx}',
  'shared/**/*.{ts,tsx}',
  'apps/*/{app,site,api,shared}/**/*.{ts,tsx}',
] as const;

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

const skip = (path: string): boolean =>
  path.includes('node_modules') || path.includes('/dist/') || path.startsWith('dist/');

export const tooLongFinding = (path: string, lines: number): Finding => ({
  code: 'X_FILE_TOO_LONG',
  cause: `${path} is ${lines} lines, over the ${LINE_CEILING} line ceiling`,
  fix: `split ${path}: one file, one responsibility`,
  docs: docs('X_FILE_TOO_LONG'),
  at: path,
});

/**
 * A trailing newline terminates the last line, it does not start another one. Counting the split
 * parts instead made the real ceiling 499 and reported every count one too high — every correctly
 * formatted file here ends with a newline, which is exactly the case that was wrong.
 */
export const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** Files are the unit of review: one file, one job, hard ceiling 500 lines. */
export async function checkFileSizes(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const pattern of SOURCE_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      if (skip(path) || seen.has(path)) continue;
      seen.add(path);
      const lines = countLines(await Bun.file(join(root, path)).text());
      if (lines > LINE_CEILING) findings.push(tooLongFinding(path, lines));
    }
  }
  return findings;
}

export const missingFileFinding = (dir: string, file: string, scaffolder: boolean): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir} has no ${file}`,
  fix: scaffolder
    ? `bun run scripts/new-package.ts ${dir} --only ${file}`
    : `add packages/${dir}/${file}, shaped like the one in a sibling package`,
  docs: docs('X_PACKAGE_SHAPE'),
  at: `packages/${dir}/${file}`,
});

export async function workspacePackages(root: string): Promise<readonly string[]> {
  const dirs: string[] = [];
  for await (const path of new Bun.Glob('packages/*/package.json').scan({
    cwd: root,
    absolute: false,
  })) {
    const dir = path.split('/')[1];
    if (dir !== undefined) dirs.push(dir);
  }
  return dirs.sort();
}

export const hasWorkspacePackages = async (root: string): Promise<boolean> =>
  (await workspacePackages(root)).length > 0;

/** Every package ships the same contract files; a missing one is a build error, not a chore. */
export async function checkPackageShape(root: string): Promise<readonly Finding[]> {
  const scaffolder = existsSync(join(root, 'scripts', 'new-package.ts'));
  const findings: Finding[] = [];
  for (const dir of await workspacePackages(root)) {
    for (const file of PACKAGE_FILES) {
      if (existsSync(join(root, 'packages', dir, file))) continue;
      findings.push(missingFileFinding(dir, file, scaffolder));
    }
  }
  return findings;
}
