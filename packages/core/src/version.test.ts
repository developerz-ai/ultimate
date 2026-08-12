// `FRAMEWORK_VERSION` was `undefined` in every process for a whole release: it was read from the
// workspace root, which is `private` and has no `version`, and the type said `string` so nothing
// complained. Then the read that fixed that ran at module scope, so a compiled single-file binary
// threw before `main`. These tests pin the value to this package's own manifest, pin the
// build-define fallback that a binary has instead of one, and pin the failure loud.

import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { UltimateError } from './errors';
import {
  frameworkVersion,
  readPackageVersion,
  resolveVersion,
  VERSION_DEFINE,
  VERSION_MANIFEST,
} from './version';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

const missing = join(import.meta.dir, '.no-such-manifest-here', 'package.json');

describe('frameworkVersion', () => {
  test('is a real semver string, not undefined', () => {
    expect(typeof frameworkVersion()).toBe('string');
    expect(frameworkVersion()).toMatch(SEMVER);
  });

  test('equals the version in this package’s own package.json', async () => {
    const manifest = (await Bun.file(VERSION_MANIFEST).json()) as { version: string };
    expect(frameworkVersion()).toBe(manifest.version);
  });

  test('caches — the second call reads no manifest at all', () => {
    // Comparing two return values would pass whether or not the memo exists. The claim is the
    // read that does NOT happen, so the read is what the test watches.
    const first = frameworkVersion();
    const spy = spyOn(fs, 'readFileSync');
    try {
      expect(frameworkVersion()).toBe(first);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('resolves the package manifest, never the workspace root', async () => {
    expect(VERSION_MANIFEST.endsWith(join('core', 'package.json'))).toBe(true);
    const manifest = (await Bun.file(VERSION_MANIFEST).json()) as { name: string };
    expect(manifest.name).toBe('@ultimat3/core');
  });
});

describe('resolveVersion', () => {
  test('the manifest wins whenever there is one', () => {
    expect(resolveVersion(VERSION_MANIFEST, '9.9.9')).not.toBe('9.9.9');
  });

  test('a missing manifest falls through to the build define — the compiled-binary case', () => {
    expect(resolveVersion(missing, '1.2.3-beta.1')).toBe('1.2.3-beta.1');
  });

  test('a manifest that exists but declares no version still throws, define or not', async () => {
    const path = join(import.meta.dir, '.version-fixture-broken-publish.json');
    await Bun.write(path, JSON.stringify({ name: '@ultimat3/root', private: true }));
    try {
      expect(() => resolveVersion(path, '1.2.3')).toThrow(UltimateError);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test('a define that is not semver is not a version', () => {
    expect(() => resolveVersion(missing, 'latest')).toThrow(UltimateError);
  });

  test('neither source is X_INVARIANT, naming the define and a build that passes it', () => {
    expect(() => resolveVersion(missing, undefined)).toThrow(UltimateError);
    try {
      resolveVersion(missing, undefined);
    } catch (error) {
      expect((error as UltimateError).code).toBe('X_INVARIANT');
      expect((error as UltimateError).cause).toContain(VERSION_DEFINE);
      expect((error as UltimateError).fix).toContain('x build --target binary');
    }
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
