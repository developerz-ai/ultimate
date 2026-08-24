// The derivation, over synthetic trees with a known answer and over this one — so "it names the
// right packages today" and "it would name a new one tomorrow" stay separate claims.

import { describe, expect, test } from 'bun:test';
// why: `mkdtemp` is the only temp-directory API in the runtime, and a synthetic tree is what makes
// each half of the derivation provable without editing a package another agent holds.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserBarrels,
  CLIENT_BARRELS,
  isProgramPackage,
  packageFacts,
  programImports,
  programPackages,
  seamPackages,
} from './browser-barrel-set';
import { repoRoot } from './run';

const tree = (name: string): Promise<string> => mkdtemp(join(tmpdir(), `ultimate-${name}-`));

describe('the seam half', () => {
  /**
   * The set's own non-vacuity, and the only line here a human ever edits. A FLOOR, not a pin: a new
   * adopter arrives by derivation and needs no entry, so this list can only ever SHRINK — and it
   * shrinks when a package genuinely stops naming the seam, which is a fact worth one deliberate
   * deletion. Without it a derivation that returned nothing would register zero `describe.each`
   * blocks in `scripts/browser-barrel.test.ts` and that file would report "0 fail".
   */
  test('is derived from source and still covers every package known to touch the seam', () => {
    const barrels = browserBarrels(repoRoot());
    for (const name of ['ai', 'core', 'db', 'entity']) expect(barrels).toContain(name);
  });

  /**
   * Three at once: a package that adopts the seam enters, a package that does not stays out, and a
   * `.test.ts` counts for nobody.
   */
  test('a package that adopts the seam tomorrow enters the set by existing', async () => {
    const root = await tree('seam');
    await Bun.write(
      join(root, 'packages/adopter/src/scope.ts'),
      "import { asyncContext } from '@ultimat3/core';\n",
    );
    await Bun.write(join(root, 'packages/quiet/src/index.ts'), 'export const ok = 1;\n');
    await Bun.write(
      join(root, 'packages/tested/src/a.test.ts'),
      'const store = new AsyncLocalStorage();\n',
    );
    expect(seamPackages(root)).toEqual(['adopter']);
  });
});

describe('the program half', () => {
  /**
   * The exclusion, derived from the manifest and from nothing else: the SAME source file is in the
   * set or out of it depending on one `bin` key. Written this way because the alternative — a name
   * on a list — is the defect class the derivation exists to close, and a `cli` deleted from a list
   * because it was red would read identically to a rule.
   */
  test('a `bin` takes a package out of the set, and nothing else about it does', async () => {
    const root = await tree('program');
    await Bun.write(
      join(root, 'packages/tool/src/index.ts'),
      "import { asyncContext } from '@ultimat3/core';\n",
    );
    await Bun.write(join(root, 'packages/tool/package.json'), '{ "name": "@x/tool" }\n');
    expect(seamPackages(root)).toEqual(['tool']);
    expect(browserBarrels(root)).toEqual(['tool']);
    expect(programPackages(root)).toEqual([]);

    await Bun.write(
      join(root, 'packages/tool/package.json'),
      '{ "name": "@x/tool", "bin": { "tool": "./src/bin.ts" } }\n',
    );
    expect(isProgramPackage(root, 'tool')).toBe(true);
    expect(programPackages(root)).toEqual(['tool']);
    // The seam half is unchanged — the package still names it. Only the browser set moves.
    expect(seamPackages(root)).toEqual(['tool']);
    expect(browserBarrels(root)).toEqual([]);
  });

  test('a manifest nobody can parse is not evidence of a program', async () => {
    const root = await tree('unparsable');
    await Bun.write(join(root, 'packages/broken/package.json'), '{ "bin": ,}\n');
    expect(packageFacts(root, 'broken')).toBeUndefined();
    expect(isProgramPackage(root, 'broken')).toBe(false);
  });

  test('a package with no manifest at all is not a program either', async () => {
    const root = await tree('bare');
    await Bun.write(join(root, 'packages/bare/src/index.ts'), 'export const ok = 1;\n');
    expect(packageFacts(root, 'bare')).toBeUndefined();
  });
});

describe('the reach rule, over a tree with a known answer', () => {
  const program = '{ "name": "@x/tool", "bin": { "tool": "./src/bin.ts" } }\n';

  test('a library importing a program is found, by the name the manifest declares', async () => {
    const root = await tree('reach');
    await Bun.write(join(root, 'packages/tool/package.json'), program);
    await Bun.write(join(root, 'packages/tool/src/index.ts'), 'export const run = 1;\n');
    await Bun.write(join(root, 'packages/lib/package.json'), '{ "name": "@x/lib" }\n');
    await Bun.write(join(root, 'packages/lib/src/a.ts'), "import { run } from '@x/tool';\n");
    // Two files, one finding: the reach is the package's, not the file's.
    await Bun.write(join(root, 'packages/lib/src/b.ts'), "export * from '@x/tool/deep/thing';\n");
    expect(programImports(root)).toEqual([{ importer: 'lib', program: 'tool' }]);
  });

  test('a program reaching another program, and a test file, are nobody in a bundle', async () => {
    const root = await tree('reach-quiet');
    await Bun.write(join(root, 'packages/tool/package.json'), program);
    await Bun.write(
      join(root, 'packages/other/package.json'),
      '{ "name": "@x/o", "bin": "b.ts" }\n',
    );
    await Bun.write(join(root, 'packages/other/src/a.ts'), "import '@x/tool';\n");
    await Bun.write(join(root, 'packages/lib/package.json'), '{ "name": "@x/lib" }\n');
    await Bun.write(join(root, 'packages/lib/src/a.test.ts'), "import '@x/tool';\n");
    expect(programImports(root)).toEqual([]);
  });

  test('a name that merely CONTAINS a program name is not a reach', async () => {
    const root = await tree('reach-prefix');
    await Bun.write(join(root, 'packages/tool/package.json'), program);
    await Bun.write(join(root, 'packages/lib/package.json'), '{ "name": "@x/lib" }\n');
    await Bun.write(join(root, 'packages/lib/src/a.ts'), "import '@x/toolkit';\n");
    expect(programImports(root)).toEqual([]);
  });
});

/**
 * The soundness conditions of the exclusion, asserted on THIS tree. A program is out of the browser
 * set because no browser can reach it, and both of these are ways that could stop being true.
 */
describe('a program stays out of every browser bundle', () => {
  test('nothing that is not a program imports one', () => {
    // A library importing `@ultimat3/cli` puts the CLI's modules back into a bundle graph nothing
    // here builds. The tier table forbids it independently; this is the same rule, derived.
    expect(programImports(repoRoot())).toEqual([]);
  });

  test('a program never IS a client barrel', () => {
    // The four barrels an app's island build reaches are bundled by name in
    // `scripts/browser-barrel.test.ts`, so a program appearing there would be excluded from one
    // half of that file and required to bundle by the other.
    const programs = programPackages(repoRoot());
    expect(CLIENT_BARRELS.filter((name) => programs.includes(name))).toEqual([]);
  });

  test('the tree still holds a program, so the two rules above are not vacuous', () => {
    // Not a pin on WHICH one: the day this repo ships no `bin` at all, the exclusion is inert and
    // this line is what says so out loud instead of leaving two green tautologies behind.
    expect(programPackages(repoRoot()).length).toBeGreaterThan(0);
  });
});
