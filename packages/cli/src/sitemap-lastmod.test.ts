// `lastmodOf`: where each sitemap `<lastmod>` comes from, and the fallbacks that keep a sitemap
// servable where there is no work tree. Failure cases first.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no temp-dir or recursive remove.
import { tmpdir } from 'node:os'; // why: Bun exposes no temp-dir location.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { exec } from './exec';
import { lastmodOf, resetLastmodCache } from './sitemap-lastmod';

const REPO = join(import.meta.dir, '..', '..', '..');

afterEach(() => resetLastmodCache());

describe('lastmodOf — fallbacks', () => {
  test("'git' outside a work tree falls back to the file's mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lastmod-'));
    try {
      await Bun.write(join(dir, 'page.tsx'), 'export {};\n');
      const stamp = lastmodOf('page.tsx', 'git', dir);
      expect(stamp).toBeDefined();
      expect(Number.isFinite(Date.parse(stamp ?? ''))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("'none' is always undefined", () => {
    expect(lastmodOf('package.json', 'none', REPO)).toBeUndefined();
  });
});

describe('lastmodOf', () => {
  test("'git' is the last commit that touched the file, in UTC", async () => {
    // Awaited through the CLI's one subprocess boundary, never `Bun.spawnSync`: a synchronous wait
    // holds the test worker's only thread, so a git that does not come back is a worker the test
    // timeout cannot end.
    const run = await exec(['git', 'log', '-1', '--format=%cI', '--', 'package.json'], {
      cwd: REPO,
    });
    const committed = run.stdout.trim();
    // A checkout without history (an exported tarball) has nothing to compare against.
    if (!run.ok || committed === '') return;
    expect(lastmodOf('package.json', 'git', REPO)).toBe(new Date(committed).toISOString());
  });

  test('a date is read once per file per process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lastmod-'));
    try {
      await Bun.write(join(dir, 'a.tsx'), 'x');
      const first = lastmodOf('a.tsx', 'mtime', dir);
      await rm(join(dir, 'a.tsx'));
      expect(lastmodOf('a.tsx', 'mtime', dir)).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
