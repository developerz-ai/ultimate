// The repo's own installed tool (`tsc`, `biome`, an app's `x`), as a path `Bun.spawn` can start on
// every host. `node_modules/.bin/<tool>` is a symlink on POSIX and does not exist on Windows, where
// `bun install` writes `<tool>.exe` beside it — so the name is resolved, never spelled.

// why: Bun ships no path-join API; `join` builds the host-separator directory `Bun.which` searches.
import { join } from 'node:path';

/**
 * `<dir>/node_modules/.bin/<name>` resolved the way the host's shell would — `tsc.exe` on Windows,
 * `tsc` elsewhere. Not installed answers the bare POSIX path, so the spawn that fails names the
 * file a `bun install` would have created rather than an empty string.
 */
export const localBin = (dir: string, name: string): string => {
  const bin = join(dir, 'node_modules', '.bin');
  return Bun.which(name, { PATH: bin }) ?? join(bin, name);
};
