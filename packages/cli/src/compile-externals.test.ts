// Holds the one rule `compile-externals.ts` exists to make mechanical: every `bun build --compile`
// whose graph reaches this package splices the allowlist in. A copy that forgot is a build that
// fails on Bun 1.3 and passes on Bun 1.4 — which is exactly how it reached `main`.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { binaryArgs } from './cmd-build';
import { COMPILE_EXTERNALS, externalArgs } from './compile-externals';

const PACKAGE_ROOT = join(import.meta.dir, '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');

/**
 * A compile site spells the flag as an argv ELEMENT, quoted. Prose does not: three files in this
 * package say `--compile` inside a comment or a scaffolded template, and a marker that matched them
 * would report findings about files that spawn nothing — the failure mode a guard cannot afford.
 */
const COMPILE_MARKER = "'--compile'";

/** Every `.ts`/`.tsx` under `dir`, recursively. `node_modules` never holds a site of ours. */
function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/**
 * A file is a compile site if it spells `--compile`, and it satisfies the rule if it CALLS the
 * shared allowlist. The call and not the name: dropping the spread while leaving the import behind
 * is the shape a bad rebase produces, and a name test reads that as guarded. Deliberately not a
 * resolution test either — one constant is the only place the specifier may be written down, so a
 * site spelling `--external @babel/preset-typescript` by hand is a finding too.
 */
function unguardedSites(files: readonly string[]): readonly string[] {
  return files.filter((file) => {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(COMPILE_MARKER)) return false;
    return !text.includes('externalArgs()');
  });
}

describe('externalArgs', () => {
  test('one `--external` pair per specifier, in the order the constant declares them', () => {
    expect(externalArgs()).toEqual(COMPILE_EXTERNALS.flatMap((s) => ['--external', s]));
  });

  test('the allowlist is not empty — an empty one would make every guard below vacuous', () => {
    expect(COMPILE_EXTERNALS.length).toBeGreaterThan(0);
  });
});

describe('every compile site carries the allowlist', () => {
  test('`binaryArgs` splices it in ahead of the entry point, where bun reads flags', () => {
    const args = binaryArgs('/app', '/out/app');
    for (const specifier of COMPILE_EXTERNALS) {
      const at = args.indexOf(specifier);
      expect(at, `binaryArgs does not pass --external ${specifier}`).toBeGreaterThan(0);
      expect(args[at - 1]).toBe('--external');
      expect(at).toBeLessThan(args.indexOf('--outfile'));
    }
  });

  test('no file in this package spells `--compile` without it', () => {
    const sites = unguardedSites([
      ...sourceFiles(join(PACKAGE_ROOT, 'src')),
      ...sourceFiles(join(PACKAGE_ROOT, 'e2e')),
    ]);
    expect(sites, `add \`...externalArgs()\` to: ${sites.join(', ')}`).toEqual([]);
  });

  test("the framework's own image compiles this package's `bin.ts`, so its Dockerfile carries it", () => {
    const path = join(REPO_ROOT, 'docker', 'Dockerfile');
    const text = readFileSync(path, 'utf8');
    expect(
      text.includes('--external @babel/preset-typescript'),
      `docker/Dockerfile compiles packages/cli/src/bin.ts, whose graph reaches @babel/core. ` +
        `fix: add \`--external @babel/preset-typescript \\\` to the \`bun build --compile\` RUN ` +
        `line, matching COMPILE_EXTERNALS in packages/cli/src/compile-externals.ts`,
    ).toBe(true);
  });
});
