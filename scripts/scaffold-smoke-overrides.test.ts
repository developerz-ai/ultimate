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
