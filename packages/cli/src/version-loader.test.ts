// `cliVersion()` and every dependency `x new` pins come from here. It read the workspace root's
// `package.json`, which has no `version`, so both were `undefined` — silently, because the return
// type said `string`. This pins the loader to the CLI's own manifest.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { VERSION_DEFINE } from '@ultimat3/core';
import { cliVersion } from './registry';
import { CLI_MANIFEST, loadVersion } from './version-loader';

describe('loadVersion', () => {
  test('returns a real semver string, not undefined', () => {
    expect(loadVersion()).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/);
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
