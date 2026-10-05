// A tracked app's root holds real files, never symlinks: Windows checks a symlink out as a text
// file holding its target's NAME (`core.symlinks=false`, the default without Developer Mode), so
// `dummy/social-media-clone/AGENTS.md -> CLAUDE.md` read there as the nine bytes `CLAUDE.md`.
// The copy that replaced it is held byte-equal to its source here, or it drifts the first edit.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun.file() follows a link, so only lstat can say a root entry IS one.
import { lstat } from 'node:fs/promises';
// why: Bun ships no path-join API; the checkout is opened with the host's separator.
import { join } from 'node:path';
import { GATED_APPS } from './lib/gated-apps';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** Each copy and the file it must equal, repo-relative. The source is the one that is edited. */
const COPIES: readonly { readonly copy: string; readonly source: string }[] = [
  { copy: 'dummy/social-media-clone/AGENTS.md', source: 'dummy/social-media-clone/CLAUDE.md' },
];

describe('a tracked app root', () => {
  test('holds no symlink, which a Windows checkout turns into a file naming its target', async () => {
    const root = repoRoot();
    const links: string[] = [];
    for (const app of GATED_APPS) {
      const dir = join(root, app.dir);
      const glob = new Bun.Glob('*');
      for await (const name of glob.scan({ cwd: dir, onlyFiles: false, dot: true })) {
        if ((await lstat(join(dir, name))).isSymbolicLink()) links.push(`${app.dir}/${name}`);
      }
    }
    // fix: replace each with a real copy of its target, then list it in COPIES above.
    expect(links).toEqual([]);
  });

  for (const { copy, source } of COPIES) {
    test(`${copy} is byte-equal to ${source}`, async () => {
      const root = repoRoot();
      const [held, wanted] = await Promise.all([
        Bun.file(join(root, copy)).text(),
        Bun.file(join(root, source)).text(),
      ]);
      // fix: cp <source> <copy> — the source is the page that is edited, the copy follows it.
      expect(held).toBe(wanted);
    });
  }
});
