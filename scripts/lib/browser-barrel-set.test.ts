// The derivation, over synthetic trees with a known answer and over this one — so "it names the
// right packages today" and "it would name a new one tomorrow" stay separate claims.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: `mkdtemp` is the only temp-directory API in the runtime, and a synthetic tree is what makes
// each half of the derivation provable without editing a package another agent holds.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  browserBarrels,
  CLIENT_BARRELS,
  excludedImports,
  excludedPackages,
  isBunOnlyPackage,
  isProgramPackage,
  packageFacts,
  programPackages,
  seamPackages,
} from './browser-barrel-set';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

/** Every temp dir this file makes, removed after it: a fixture that outlives its run is a leftover (#738). */
const madeDirs: string[] = [];
afterAll(async () => {
  for (const dir of madeDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** Records a directory `mkdtemp` made, for the removal above. */
const made = (dir: string): string => {
  madeDirs.push(dir);
  return dir;
};

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const tree = (name: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `ultimate-${name}-`)).then(made);

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

describe('the Bun-only half', () => {
  /**
   * The same source file in the set or out of it on one line of its BARREL: a library whose `"."`
   * imports a Bun builtin has no browser build at all, so no browser evaluates its seam.
   */
  test('a barrel importing a Bun builtin takes a library out, and a deeper module does not', async () => {
    const root = await tree('bun-only');
    await Bun.write(join(root, 'packages/harness/package.json'), '{ "name": "@x/harness" }\n');
    await Bun.write(
      join(root, 'packages/harness/src/scope.ts'),
      "import { asyncContext } from '@ultimat3/core';\nimport { test } from 'bun:test';\n",
    );
    await Bun.write(join(root, 'packages/harness/src/index.ts'), "export * from './scope';\n");
    // A builtin below the barrel is not enough: the bundler reaches it, but the claim is about the
    // entry, and a deeper one is the browser suite's finding to make, not this exclusion's.
    expect(isBunOnlyPackage(root, 'harness')).toBe(false);
    expect(browserBarrels(root)).toEqual(['harness']);

    await Bun.write(
      join(root, 'packages/harness/src/index.ts'),
      "export { expect } from 'bun:test';\nexport * from './scope';\n",
    );
    expect(isBunOnlyPackage(root, 'harness')).toBe(true);
    expect(isProgramPackage(root, 'harness')).toBe(false);
    expect(excludedPackages(root)).toEqual(['harness']);
    expect(seamPackages(root)).toEqual(['harness']);
    expect(browserBarrels(root)).toEqual([]);
  });

  test('a library importing a Bun-only one is a reach, like a program', async () => {
    const root = await tree('bun-only-reach');
    await Bun.write(join(root, 'packages/harness/package.json'), '{ "name": "@x/harness" }\n');
    await Bun.write(
      join(root, 'packages/harness/src/index.ts'),
      "export { expect } from 'bun:test';\n",
    );
    await Bun.write(join(root, 'packages/lib/package.json'), '{ "name": "@x/lib" }\n');
    await Bun.write(join(root, 'packages/lib/src/a.ts'), "import { expect } from '@x/harness';\n");
    expect(excludedImports(root)).toEqual([{ importer: 'lib', excluded: 'harness' }]);
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
    expect(excludedImports(root)).toEqual([{ importer: 'lib', excluded: 'tool' }]);
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
    expect(excludedImports(root)).toEqual([]);
  });

  test('a name that merely CONTAINS a program name is not a reach', async () => {
    const root = await tree('reach-prefix');
    await Bun.write(join(root, 'packages/tool/package.json'), program);
    await Bun.write(join(root, 'packages/lib/package.json'), '{ "name": "@x/lib" }\n');
    await Bun.write(join(root, 'packages/lib/src/a.ts'), "import '@x/toolkit';\n");
    expect(excludedImports(root)).toEqual([]);
  });
});

/**
 * The soundness conditions of the exclusion, asserted on THIS tree. A program or a Bun-only library
 * is out of the browser set because no browser can reach it, and both of these are ways that could stop being true.
 */
describe('an excluded package stays out of every browser bundle', () => {
  test('nothing that is not excluded imports one', () => {
    // A library importing `@ultimat3/cli` puts the CLI's modules back into a bundle graph nothing
    // here builds. The tier table forbids it independently; this is the same rule, derived.
    expect(excludedImports(repoRoot())).toEqual([]);
  });

  test('an excluded package never IS a client barrel', () => {
    // The four barrels an app's island build reaches are bundled by name in
    // `scripts/browser-barrel.test.ts`, so a program appearing there would be excluded from one
    // half of that file and required to bundle by the other.
    const excluded = excludedPackages(repoRoot());
    expect(CLIENT_BARRELS.filter((name) => excluded.includes(name))).toEqual([]);
  });

  test('the tree still holds a program and a Bun-only library, so the rules above are not vacuous', () => {
    // Not a pin on WHICH one: the day this repo ships no `bin` at all, the exclusion is inert and
    // this line is what says so out loud instead of leaving two green tautologies behind.
    expect(programPackages(repoRoot()).length).toBeGreaterThan(0);
    const root = repoRoot();
    expect(
      excludedPackages(root).filter((dir) => isBunOnlyPackage(root, dir)).length,
    ).toBeGreaterThan(0);
  });
});
