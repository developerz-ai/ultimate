// Whether a deploy workflow publishes: every path since the last publish is one the app never
// ships, or it publishes — and every doubt publishes.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: Bun ships no path API.
import { type DeployApp, deployDue } from './deploy-due';

const ahead = (files: readonly string[]): unknown => ({ status: 'ahead', files });

describe('unit · ci · a publish no shipped path changed is skipped', () => {
  test.each<[DeployApp, string]>([
    ['social', 'wiki/Home.md'],
    ['social', 'docs/history/ci-split.md'],
    ['social', 'scripts/verify.ts'],
    ['social', 'examples/dummy/apps/web/page.tsx'],
    ['social', 'dummy/docs-site/apps/web/shared/docs.ts'],
    ['social', 'packages/create-ultimate/src/index.ts'],
    ['social', 'README.md'],
    ['social', '.github/workflows/ci.yml'],
    ['social', '.claude/hooks/after-edit.ts'],
    ['docs', 'docs/plans/2026/11/27/x/status.yml'],
    ['docs', 'scripts/verify.ts'],
    ['docs', 'examples/dummy/apps/web/page.tsx'],
    ['docs', 'dummy/social-media-clone/apps/web/page.tsx'],
    ['docs', 'docker/Dockerfile'],
    ['docs', 'CHANGELOG.md'],
    ['docs', '.github/workflows/ci.yml'],
  ])('%s: %s alone is not due', (app, path) => {
    const verdict = deployDue(app, ahead([path]));
    expect(verdict.due).toBe(false);
    expect(verdict.shipped).toEqual([]);
  });

  test('nothing changed since the last publish: not due', () => {
    expect(deployDue('social', { status: 'identical', files: [] }).due).toBe(false);
  });
});

describe('unit · ci · a shipped path, or any doubt, publishes', () => {
  test.each<[DeployApp, string]>([
    ['social', 'dummy/social-media-clone/apps/web/page.tsx'],
    ['social', 'packages/core/src/errors.ts'],
    ['social', 'bun.lock'],
    ['social', 'docker/Dockerfile'],
    ['social', 'package.json'],
    ['social', 'examples/dummy/package.json'],
    ['social', 'tsconfig.base.json'],
    ['social', 'framework.manifest.json'],
    ['social', '.github/workflows/deploy-social-demo.yml'],
    ['social', 'newdir/anything.ts'],
    ['docs', 'wiki/Home.md'],
    ['docs', 'dummy/docs-site/apps/web/shared/docs.ts'],
    ['docs', 'packages/ui/src/button.tsx'],
    ['docs', 'framework.manifest.json'],
    ['docs', 'bun.lock'],
    ['docs', 'dummy/social-media-clone/package.json'],
    ['docs', '.github/workflows/deploy-docs-site.yml'],
    ['docs', 'newdir/anything.ts'],
  ])('%s: %s is due, and named', (app, path) => {
    const verdict = deployDue(app, ahead(['wiki/x.md', 'scripts/a.ts', path]));
    expect(verdict.due).toBe(true);
    expect(verdict.shipped).toContain(path);
  });

  // git and the API quote odd bytes, and a path that climbs out is not a repo path.
  test.each(['"wiki/caf\\303\\251.md"', 'wiki/../packages/core/src/x.ts'])('%s is due', (path) => {
    expect(deployDue('social', ahead([path])).due).toBe(true);
  });

  test.each([
    ['no comparison at all', undefined],
    ['not an object', 'ahead'],
    ['no status', { files: [] }],
    ['behind the last publish', { status: 'behind', files: [] }],
    ['diverged from it', { status: 'diverged', files: ['scripts/a.ts'] }],
    ['no file list', { status: 'ahead' }],
    ['a file that is not a string', { status: 'ahead', files: [3] }],
    // The compare API lists at most 300 files: a full page may hide the one that ships.
    ['a capped list', ahead(Array.from({ length: 300 }, (_, i) => `scripts/p${String(i)}.ts`))],
  ])('%s: due', (_, compare) => {
    expect(deployDue('docs', compare).due).toBe(true);
  });
});

// The demo's build job holds the registry credential, so it runs this on bun alone, with no
// `bun install` beside the secret: the script must import nothing at all.
describe('unit · ci · deploy-due runs with no install', () => {
  test('copied alone into an empty directory, it answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deploy-due-'));
    try {
      await Bun.write(join(dir, 'deploy-due.ts'), Bun.file(join(import.meta.dir, 'deploy-due.ts')));
      await Bun.write(join(dir, 'compare.json'), JSON.stringify(ahead(['packages/core/a.ts'])));
      const child = Bun.spawn(['bun', 'run', 'deploy-due.ts', '--app', 'docs', 'compare.json'], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const doc = JSON.parse(out) as { ok: boolean; data: { due: boolean } };
      expect(doc.ok).toBe(true);
      expect(doc.data.due).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing comparison file and an unknown app: due, never red', async () => {
    const run = Bun.spawn(['bun', 'run', join(import.meta.dir, 'deploy-due.ts'), '--app', 'x'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const doc = JSON.parse(await new Response(run.stdout).text()) as { data: { due: boolean } };
    expect(await run.exited).toBe(0);
    expect(doc.data.due).toBe(true);
  });
});
