// `FRAMEWORK_VERSION` was `undefined` in every process for a whole release: it was read from the
// workspace root, which is `private` and has no `version`, and the type said `string` so nothing
// complained. These tests pin the value to this package's own manifest and pin the failure loud.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { UltimateError } from './errors';
import { FRAMEWORK_VERSION, readPackageVersion, VERSION_MANIFEST } from './version';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

describe('FRAMEWORK_VERSION', () => {
  test('is a real semver string, not undefined', () => {
    expect(typeof FRAMEWORK_VERSION).toBe('string');
    expect(FRAMEWORK_VERSION).toMatch(SEMVER);
  });

  test('equals the version in this package’s own package.json', async () => {
    const manifest = (await Bun.file(VERSION_MANIFEST).json()) as { version: string };
    expect(FRAMEWORK_VERSION).toBe(manifest.version);
  });

  test('resolves the package manifest, never the workspace root', async () => {
    expect(VERSION_MANIFEST.endsWith(join('core', 'package.json'))).toBe(true);
    const manifest = (await Bun.file(VERSION_MANIFEST).json()) as { name: string };
    expect(manifest.name).toBe('@ultimat3/core');
  });
});

describe('readPackageVersion', () => {
  const write = async (body: unknown): Promise<string> => {
    const path = join(
      import.meta.dir,
      `.version-fixture-${Math.random().toString(36).slice(2)}.json`,
    );
    await Bun.write(path, JSON.stringify(body));
    return path;
  };

  test('reads a valid version', async () => {
    const path = await write({ name: 'x', version: '1.2.3-beta.1' });
    expect(readPackageVersion(path)).toBe('1.2.3-beta.1');
    await Bun.file(path).delete();
  });

  test('throws X_INVARIANT when the manifest has no version — the root package.json case', async () => {
    const path = await write({ name: '@ultimat3/root', private: true });
    expect(() => readPackageVersion(path)).toThrow(UltimateError);
    try {
      readPackageVersion(path);
    } catch (error) {
      expect((error as UltimateError).code).toBe('X_INVARIANT');
    }
    await Bun.file(path).delete();
  });

  test('throws X_INVARIANT when the version is not semver', async () => {
    const path = await write({ version: 'latest' });
    expect(() => readPackageVersion(path)).toThrow(UltimateError);
    await Bun.file(path).delete();
  });
});
