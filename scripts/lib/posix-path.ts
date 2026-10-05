// The one spelling a repo-relative path takes in scripts/: `/`-separated. On Windows `Bun.Glob`,
// `relative()` and `Bun.main` all answer with `\`, and every key, finding and pin in this repo is
// written with `/` — so a path that becomes a key, a finding or a pasted fix passes through here.

// The LEAF, never the `@ultimat3/cli` barrel: these scripts must run while a package is mid-edit,
// and one implementation of the `/` spelling serves the CLI and the gate scripts alike.
import { posixRelative, toPosix } from '../../packages/cli/src/posix-path';

export { posixRelative, toPosix };

/**
 * `path` relative to `root` when it lies inside it, `/`-separated; `undefined` when it is outside.
 * Compared `/`-normalised, so a Windows `D:\repo\x` is inside `D:\repo` whichever separator each
 * side was spelt with.
 */
export const insideRoot = (root: string, path: string): string | undefined => {
  const base = toPosix(root).replace(/\/+$/, '');
  const full = toPosix(path);
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : undefined;
};
