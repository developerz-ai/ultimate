// `cliVersion()` and every dependency `x new` pins come from here. It read the workspace root's
// `package.json`, which has no `version`, so both were `undefined` — silently, because the return
// type said `string`. This pins the loader to the CLI's own manifest.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { VERSION_DEFINE } from '@ultimat3/core';
import { cliVersion } from './registry';
import { CLI_MANIFEST, loadVersion } from './version-loader';
import { SEMVER } from './workspace-checks';

describe('loadVersion', () => {
  test('returns a real semver string, not undefined', () => {
    expect(loadVersion()).toMatch(SEMVER);
  });

  test('reads @ultimat3/cli’s own manifest, not the workspace root', async () => {
    expect(CLI_MANIFEST.endsWith(join('cli', 'package.json'))).toBe(true);
    const manifest = (await Bun.file(CLI_MANIFEST).json()) as {
      name: string;
      version: string;
    };
    expect(manifest.name).toBe('@ultimat3/cli');
    expect(loadVersion()).toBe(manifest.version);
  });

  test('cliVersion() is the loaded value — `x --version` never prints "undefined"', () => {
    expect(cliVersion()).toBe(loadVersion());
    expect(cliVersion()).not.toContain('undefined');
  });

  // The binary case itself is `e2e/registry-boot.e2e.test.ts`; only a compile can produce a define.
  // What this pins is the name: the identifier the loader falls back to is core's, so renaming
  // `VERSION_DEFINE` cannot leave `x --version` silently reading a define nothing passes.
  test('falls back to the define core declares, not a second one of its own', async () => {
    const source = await Bun.file(join(import.meta.dir, 'version-loader.ts')).text();
    expect(source).toContain(`declare const ${VERSION_DEFINE}:`);
    expect(source).toContain(`typeof ${VERSION_DEFINE} === 'string'`);
  });
});

// Here, not in `workspace-checks.test.ts`, which sits at the line ceiling: the version this file
// loads is matched by the same pattern the `package-shape` step reads an app's manifest with.
describe('SEMVER', () => {
  test('refuses a prerelease of `--` pairs without backtracking', () => {
    // Exponential before: 22 pairs took seconds, and each further pair doubled it.
    const started = performance.now();
    expect(SEMVER.test(`0.0.0+${'--'.repeat(22)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  }, 30_000);

  test('reads the grammar it always read', () => {
    for (const good of ['1.2.3', '1.2.3-rc.1', '1.2.3+build.5', '1.2.3-rc.1+b-7', '1.0.0--'])
      expect(SEMVER.test(good)).toBe(true);
    for (const bad of ['1.2', '1.2.3-', '1.2.3-+a', '1.2.3+', 'v1.2.3', '1.2.3 '])
      expect(SEMVER.test(bad)).toBe(false);
  });
});
