// The loopback scope's two faces: npm cut back to the day a release shipped, so a scaffold's caret
// installs that release and no later patch; npm plus HEAD, so `x upgrade --to <HEAD>` resolves.

import { describe, expect, test } from 'bun:test';
import type { PackedPackage } from './upgrade-fixtures-packument';
import {
  asOf,
  packageOfPath,
  scopeLine,
  tarballName,
  withHead,
} from './upgrade-fixtures-packument';

const NPM = {
  name: '@ultimat3/core',
  'dist-tags': { latest: '31.26.0', next: '32.0.0-rc.1' },
  time: { '31.4.0': '2026-10-01T00:00:00Z' },
  versions: {
    '31.3.0': { version: '31.3.0' },
    '31.4.0': { version: '31.4.0' },
    '31.4.2': { version: '31.4.2' },
    '31.26.0': { version: '31.26.0' },
    '32.0.0-rc.1': { version: '32.0.0-rc.1' },
  },
};

const HEAD: PackedPackage = {
  name: '@ultimat3/core',
  version: '31.27.0',
  manifest: { name: '@ultimat3/core', version: '31.27.0', engines: { bun: '>=1.4.4' } },
  file: '/pack/ultimat3-core-31.27.0.tgz',
  integrity: 'sha512-abc',
};

describe('asOf', () => {
  test('keeps releases up to the ceiling, so ^31.4.0 installs 31.4.0 and not the later 31.4.2', () => {
    const cut = asOf(NPM, '31.4.0');
    expect(Object.keys((cut?.['versions'] ?? {}) as object)).toEqual(['31.3.0', '31.4.0']);
    expect(cut?.['dist-tags']).toEqual({ latest: '31.4.0' });
  });

  test('drops every prerelease and the publish times that would name a later release', () => {
    const cut = asOf(NPM, '99.0.0');
    expect(Object.keys((cut?.['versions'] ?? {}) as object)).not.toContain('32.0.0-rc.1');
    expect(cut).not.toHaveProperty('time');
  });

  test('a package with no release at or below the ceiling did not exist yet', () => {
    expect(asOf(NPM, '1.0.0')).toBeUndefined();
    expect(asOf(undefined, '31.4.0')).toBeUndefined();
  });
});

describe('withHead', () => {
  test('adds HEAD as latest beside every npm release, its tarball on loopback', () => {
    const merged = withHead(NPM, HEAD, 'http://127.0.0.1:1/x/-/tarball/ultimat3-core-31.27.0.tgz');
    const versions = merged['versions'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(versions)).toContain('31.4.0');
    expect(versions['31.27.0']?.['engines']).toEqual({ bun: '>=1.4.4' });
    expect(versions['31.27.0']?.['dist']).toEqual({
      tarball: 'http://127.0.0.1:1/x/-/tarball/ultimat3-core-31.27.0.tgz',
      integrity: 'sha512-abc',
    });
    expect((merged['dist-tags'] as Record<string, string>)['latest']).toBe('31.27.0');
  });

  test('a package npm has never seen is HEAD alone', () => {
    const merged = withHead(undefined, HEAD, 'http://t');
    expect(Object.keys(merged['versions'] as object)).toEqual(['31.27.0']);
  });
});

describe('the scope', () => {
  test('both spellings of a scoped request name the package; anything else is refused', () => {
    expect(packageOfPath('/@ultimat3%2fcore')).toBe('@ultimat3/core');
    expect(packageOfPath('/@ultimat3/core')).toBe('@ultimat3/core');
    expect(packageOfPath('/react')).toBeUndefined();
    expect(packageOfPath('/@ultimat3%2f..%2fetc')).toBeUndefined();
    expect(packageOfPath('/%E0%A4%A')).toBeUndefined();
  });

  test('the .npmrc line moves the scope alone, and the tarball name is the one bun pm pack writes', () => {
    expect(scopeLine('http://127.0.0.1:9/a/')).toBe('@ultimat3:registry=http://127.0.0.1:9/a/\n');
    expect(tarballName('@ultimat3/core', '31.27.0')).toBe('ultimat3-core-31.27.0.tgz');
  });
});
