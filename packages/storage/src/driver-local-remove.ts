// Single responsibility: how the local disk unlinks one file of an object, and which failures mean
// "already gone". A refused unlink is reported, never swallowed: an erasure sweep that hears
// "deleted" for bytes still on disk repeats the one lie it exists to prevent.

import { renderFixShellArg, stringField } from '@ultimat3/core';
import { deleteFailed } from './errors';

/** `ENOENT` is the one delete failure that means "already in the desired state". */
export const isMissingFile = (error: unknown): boolean => stringField(error, 'code') === 'ENOENT';

/**
 * A directory at an object's path is OTHER keys' parent (`c` beside `c/d`), never an object: no
 * bytes are stored at the key, so deleting it is deleting an absent key. Asked only after an
 * unlink failed, because the errno for "that is a directory" is `EISDIR` on Linux and `EPERM` on
 * macOS — the stat is the portable answer.
 */
const isDirectory = async (path: string): Promise<boolean> =>
  Bun.file(path)
    .stat()
    .then(
      (stats) => stats.isDirectory(),
      () => false,
    );

/** Removes one path under `root`, or reports WHY it could not — a swallowed refusal is a false erasure. */
export async function removeIfPresent(root: string, path: string, key: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch (error) {
    if (isMissingFile(error) || (await isDirectory(path))) return;
    throw deleteFailed(
      'local',
      key,
      error,
      // Screened: a key may carry `$(…)` and a root is configuration, and a fix: is pasted.
      `make the disk root writable by this process, then retry: ls -ld ${renderFixShellArg(root, "'<the disk root>'")} && rm -f ${renderFixShellArg(path, "'<the object file>'")}`,
    );
  }
}
