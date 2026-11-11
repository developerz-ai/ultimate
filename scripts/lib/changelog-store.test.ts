// `loadChangelog`: the CHANGELOG.md index's [Unreleased], then one section per `docs/changelog/`
// file, newest first by number — and on this repository, every release, so no rule reads nothing.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  assembleChangelog,
  fileVersion,
  loadChangelog,
  newestFirst,
  readChangelogFiles,
  versionFile,
} from './changelog-store';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

const INDEX = '# Changelog\n\n## [Unreleased]\n\n- pending\n\n## Releases\n\n## Older releases\n';
const file = (version: string, body = '- x') => ({
  path: versionFile(version),
  text: `## ${version} - 2026-11-10\n\n${body}\n`,
});

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

describe('unit · changelog-store · one list from two places', () => {
  test('[Unreleased] from the index first, then releases newest first, by number', () => {
    const sections = assembleChangelog(INDEX, [file('9.0.0'), file('10.0.0'), file('9.10.0')]);
    expect(sections.map((one) => one.version)).toEqual(['unreleased', '10.0.0', '9.10.0', '9.0.0']);
    // The index's own headings are not releases: the table and the stub stay out.
    expect(sections.filter((one) => one.file === 'CHANGELOG.md').length).toBe(1);
  });

  test('each section names the file and line it is read from', () => {
    const [pending, release] = assembleChangelog(INDEX, [file('1.0.0', '- **BREAKING — x.**')]);
    expect([pending?.file, pending?.line]).toEqual(['CHANGELOG.md', 3]);
    expect([release?.file, release?.line, release?.breaking]).toEqual([
      'docs/changelog/1.0.0.md',
      1,
      1,
    ]);
    expect(release?.lines).toEqual(['', '- **BREAKING — x.**', '']);
  });

  test('a file name is a version or nothing', () => {
    expect(fileVersion('docs/changelog/31.3.0.md')).toEqual([31, 3, 0]);
    expect(fileVersion('docs/changelog/README.md')).toBeUndefined();
    expect(newestFirst('docs/changelog/README.md', 'docs/changelog/1.0.0.md')).toBeGreaterThan(0);
  });

  test('a tree with no docs/changelog/ reads no release, and does not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'changelog-store-'));
    made.push(dir);
    await Bun.write(join(dir, 'CHANGELOG.md'), INDEX);
    expect(await readChangelogFiles(dir)).toEqual({ index: INDEX, files: [] });
    expect((await loadChangelog(dir)).map((one) => one.version)).toEqual(['unreleased']);
  });
});

// Every changelog rule passes on an empty list, so the loader reading this repository is the one
// place "the rules read something" is proved.
describe('the committed changelog', () => {
  test(
    'is [Unreleased] and then every release file, newest first',
    async () => {
      const sections = await loadChangelog(repoRoot());
      expect(sections[0]?.version).toBe('unreleased');
      const released = sections.slice(1);
      expect(released.length).toBeGreaterThan(100);
      expect(released.every((one) => one.file === versionFile(one.version))).toBe(true);
      const paths = released.map((one) => one.file);
      expect(paths).toEqual([...paths].sort(newestFirst));
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
