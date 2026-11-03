// The newest mtime over what a static build reads, for `budgets`' freshness: the app's source files
// (tests and declarations ship no bytes), the config and the lockfile, and every directory those
// files sit in — a deleted page changes no remaining file's mtime, only its directory's.

// why: Bun exposes no path-join or dirname primitive.
import { dirname, join } from 'node:path';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import { eachSourceFile, isGenerated, isTest } from './source-files';

/**
 * Files outside `SOURCE_GLOBS` that still move a route's bytes: the config (pwa, theme, surfaces)
 * and the lockfile, whose change is a framework or dependency upgrade.
 */
const BYTE_INPUTS = [APP_CONFIG_FILE, 'bun.lock'] as const;

/** `0` for a path that vanished between the glob and the stat: it cannot be newer than anything. */
const mtimeOf = async (path: string): Promise<number> => {
  const file = Bun.file(path);
  try {
    return (await file.stat()).mtimeMs;
  } catch {
    return 0;
  }
};

/** Every directory between `path` and the root, the root itself excluded (`.x/` lives there). */
const ancestorsOf = (path: string): readonly string[] => {
  const out: string[] = [];
  for (let dir = dirname(path); dir !== '.' && dir !== '' && dir !== '/'; dir = dirname(dir)) {
    out.push(dir);
  }
  return out;
};

/** The newest mtime, in ms, or `undefined` for an app with no source at all. */
export async function newestSourceMtime(root: string): Promise<number | undefined> {
  let newest: number | undefined;
  const consider = (ms: number): void => {
    if (ms > 0 && (newest === undefined || ms > newest)) newest = ms;
  };
  const dirs = new Set<string>();
  for await (const path of eachSourceFile(root)) {
    if (isTest(path) || isGenerated(path)) continue;
    consider(await mtimeOf(join(root, path)));
    for (const dir of ancestorsOf(path)) dirs.add(dir);
  }
  for (const dir of dirs) consider(await mtimeOf(join(root, dir)));
  for (const path of BYTE_INPUTS) consider(await mtimeOf(join(root, path)));
  return newest;
}
