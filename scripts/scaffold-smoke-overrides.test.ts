import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import { applyOverrides, computeOverrides } from './scaffold-smoke-overrides';

describe('computeOverrides', () => {
  test('finds every published @ultimat3/* package under packages/', async () => {
    const overrides = await computeOverrides(repoRoot());
    expect(overrides['@ultimat3/core']).toBe(`file:${join(repoRoot(), 'packages', 'core')}`);
    expect(overrides['@ultimat3/cli']).toBe(`file:${join(repoRoot(), 'packages', 'cli')}`);
    // Every value is an absolute file: path a fresh `bun install` can resolve from anywhere.
    for (const value of Object.values(overrides)) expect(value.startsWith('file:/')).toBe(true);
  });
});

describe('applyOverrides', () => {
  test('merges onto an existing package.json without dropping other fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scaffold-smoke-'));
    try {
      const pkgPath = join(dir, 'package.json');
      await Bun.write(
        pkgPath,
        JSON.stringify({ name: 'demoapp', dependencies: { 'solid-js': '1.0.0' } }),
      );
      await applyOverrides(dir, { '@ultimat3/core': 'file:/repo/packages/core' });
      const written = await Bun.file(pkgPath).json();
      expect(written.name).toBe('demoapp');
      expect(written.dependencies).toEqual({ 'solid-js': '1.0.0' });
      expect(written.overrides).toEqual({ '@ultimat3/core': 'file:/repo/packages/core' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a second call adds to existing overrides rather than replacing them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scaffold-smoke-'));
    try {
      const pkgPath = join(dir, 'package.json');
      await Bun.write(pkgPath, JSON.stringify({ name: 'demoapp', overrides: { a: 'file:/a' } }));
      await applyOverrides(dir, { b: 'file:/b' });
      const written = await Bun.file(pkgPath).json();
      expect(written.overrides).toEqual({ a: 'file:/a', b: 'file:/b' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('unit · the empty case is a hard error, not a quiet no-op', () => {
  // `computeOverrides` returning `{}` used to be written straight through, so `bun install`
  // resolved every `@ultimat3/*` range from the NPM REGISTRY — the smoke job proving that the last
  // PUBLISHED release scaffolds and verifies, which is a claim about a different tree.
  test('a root with no packages/ answers empty rather than throwing ENOENT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-overrides-'));
    try {
      expect(await computeOverrides(dir)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a packages/ dir with nothing @ultimat3-scoped in it answers empty too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-overrides-'));
    try {
      await Bun.write(join(dir, 'packages/widget/package.json'), '{"name":"widget"}');
      expect(await computeOverrides(dir)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
