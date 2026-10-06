// Single responsibility: the one refused unlink a local-disk test can stage without root — an
// object file under a directory this process may not write — and the undo that lets the temp
// directory be removed after. A directory in the object's place is NOT one: that is an absent key.

// why: Bun has no `chmod`; a read-only parent is the portable POSIX refusal of an unlink.
import { chmod } from 'node:fs/promises';

/** Root ignores directory permissions, so under it the refusal cannot be staged at all. */
export const RUNS_AS_ROOT = process.getuid?.() === 0;

/**
 * Runs `run` with `<root>/<key>` present and its parent directory read-only — so the unlink is
 * refused with `EACCES`, the shape of a read-only mount — then makes it writable again.
 */
export async function withUndeletable<T>(
  root: string,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const path = `${root}/${key}`;
  const parent = path.slice(0, path.lastIndexOf('/'));
  await Bun.write(path, 'blocked');
  await chmod(parent, 0o555);
  try {
    return await run();
  } finally {
    await chmod(parent, 0o755);
  }
}
