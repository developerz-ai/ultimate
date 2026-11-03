// `AGENTS.md` is a relative symlink to `CLAUDE.md` in the repository root and in each tracked app,
// by the owner's ruling of 2026-11-03: one source, so the two files cannot drift. Any other symlink
// in an app root is refused, because Windows checks one out as a text file naming its target.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun.file() follows a link, so only lstat/readlink can say a root entry IS one, and to what.
import { lstat, readlink } from 'node:fs/promises';
// why: Bun ships no path-join API; the checkout is opened with the host's separator.
import { join } from 'node:path';
import { GATED_APPS } from './lib/gated-apps';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const LINK = 'AGENTS.md';
const TARGET = 'CLAUDE.md';

/** Repo-relative directories that carry the pair: the root, then every gated app. */
const DIRS: readonly string[] = ['.', ...GATED_APPS.map((app) => app.dir)];

/**
 * What the entry is on this checkout. Git for Windows without `core.symlinks` writes a link as a
 * regular file holding the target's NAME — the index still records mode 120000, so that file is
 * the link, read there; on POSIX it is a regular file only if someone replaced the link.
 */
async function linkState(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return `-> ${await readlink(path)}`;
  if (process.platform === 'win32' && (await Bun.file(path).text()) === TARGET) {
    return `-> ${TARGET}`;
  }
  return 'regular file';
}

describe('AGENTS.md', () => {
  for (const dir of DIRS) {
    test(`${join(dir, LINK)} is a relative symlink to ${TARGET}`, async () => {
      // fix: cd <dir> && ln -sf CLAUDE.md AGENTS.md — merge anything only AGENTS.md said first.
      expect(await linkState(join(repoRoot(), dir, LINK))).toBe(`-> ${TARGET}`);
    });
  }

  test('is the only symlink in a tracked app root', async () => {
    const root = repoRoot();
    const links: string[] = [];
    for (const app of GATED_APPS) {
      const dir = join(root, app.dir);
      for await (const name of new Bun.Glob('*').scan({ cwd: dir, onlyFiles: false, dot: true })) {
        if (name === LINK) continue;
        if ((await lstat(join(dir, name))).isSymbolicLink()) links.push(`${app.dir}/${name}`);
      }
    }
    // fix: replace each with a real copy of its target — a Windows checkout reads only its name.
    expect(links).toEqual([]);
  });
});
