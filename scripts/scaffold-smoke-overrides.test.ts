import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { applyOverrides, computeOverrides, smokeOverrides } from './scaffold-smoke-overrides';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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

// Plan 101 19b Y10: a `file:` install copies `packages/cli` as it stands, and `wiki/` is written
// into it only by `prepack` — so the smoke app's `x docs` answered "ships no wiki/" (`X_CLI_UNEXPECTED`)
// while every published install had one. The smoke run packs the wiki first, as a publish would.
describe('unit · the smoke app installs the CLI with the wiki its tarball ships', () => {
  test('the wiki is packed into packages/cli before the overrides point the app at it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scaffold-smoke-root-'));
    const target = await mkdtemp(join(tmpdir(), 'scaffold-smoke-app-'));
    try {
      await Bun.write(join(root, 'packages/cli/package.json'), '{"name":"@ultimat3/cli"}');
      await Bun.write(join(root, 'wiki/Home.md'), '# Home\n');
      await Bun.write(join(root, 'wiki/Error-Codes.md'), '# Codes\n');
      await Bun.write(join(target, 'package.json'), '{"name":"demoapp"}');
      const result = await smokeOverrides(root, target);
      expect(result.finding).toBeUndefined();
      expect(result.pages).toEqual(['Home.md']);
      expect(await Bun.file(join(root, 'packages/cli/wiki/Home.md')).exists()).toBe(true);
      expect((await Bun.file(join(target, 'package.json')).json()).overrides).toEqual({
        '@ultimat3/cli': `file:${join(root, 'packages', 'cli')}`,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test('a checkout with no wiki is refused before the app is pointed at a CLI without one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scaffold-smoke-root-'));
    const target = await mkdtemp(join(tmpdir(), 'scaffold-smoke-app-'));
    try {
      await Bun.write(join(root, 'packages/cli/package.json'), '{"name":"@ultimat3/cli"}');
      await Bun.write(join(target, 'package.json'), '{"name":"demoapp"}');
      const result = await smokeOverrides(root, target);
      expect(result.finding?.code).toBe('X_PACKAGE_SHAPE');
      expect((await Bun.file(join(target, 'package.json')).json()).overrides).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });
});
