// `CLI_VERSION` and every dependency `x new` pins come from here. It read the workspace root's
// `package.json`, which has no `version`, so both were `undefined` — silently, because the return
// type said `string`. This pins the loader to the CLI's own manifest.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CLI_VERSION } from './registry';
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

  test('CLI_VERSION is the loaded value — `x --version` never prints "undefined"', () => {
    expect(CLI_VERSION).toBe(loadVersion());
    expect(CLI_VERSION).not.toContain('undefined');
  });
});
