// Single responsibility: how the local disk WRITES one object — the bytes, the sidecar and a
// pending marker, staged under `.meta/.tmp/` and renamed into place in the one order whose every
// crash point reads as absent, whole or untyped; refused by code when the disk says no.

// why: Bun has no `rename` and no `mkdir` — `Bun.write` creates parents and replaces in place,
// which is exactly the non-atomic write this file exists to stop. Delete both the day Bun ships them.
import { mkdir, rename } from 'node:fs/promises';
import { renderFixShellArg, stringField } from '@ultimat3/core';
import type { Sidecar } from './driver-local-sidecar';
import { isStorageError, keyConflict, putFailed } from './errors';
import { META_DIR } from './path';

/** Inside `.meta/`, so the listing's one filter already keeps a staged file out of the keys. */
const STAGING_DIR = `${META_DIR}/.tmp`;

export const sidecarPathOf = (key: string): string => `${META_DIR}/${key}.json`;
/** Beside the sidecar, and never one itself: a sidecar's name ends in `.json`. */
export const pendingPathOf = (key: string): string => `${META_DIR}/${key}.json.pending`;

const codeOf = (error: unknown): string | undefined => stringField(error, 'code');
/** `mkdir -p` through a file, a rename onto a directory, a write under a file. */
const isPathConflict = (error: unknown): boolean =>
  ['ENOTDIR', 'EEXIST', 'EISDIR', 'ENOTEMPTY'].includes(codeOf(error) ?? '');
const isAbsent = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(codeOf(error) ?? '');

/** The object KEY a path inside the root stands for — a sidecar's path names its object. */
const keyAt = (relative: string): string =>
  relative.startsWith(`${META_DIR}/`)
    ? relative.slice(META_DIR.length + 1).replace(/\.json(\.pending)?$/, '')
    : relative;

/** The first ancestor of `relative` that is a FILE: the stored object standing where a directory must be. */
async function fileInTheWay(root: string, relative: string): Promise<string | undefined> {
  const segments = relative.split('/').slice(0, -1);
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join('/');
    if (await Bun.file(`${root}/${ancestor}`).exists()) return keyAt(ancestor);
  }
  // Nothing INSIDE the root is in the way: the root itself is the problem, and that is the
  // disk refusing the write, not two keys colliding.
  return undefined;
}

/**
 * Make `relative` writable as a FILE, or refuse. Runs for both of an object's paths BEFORE either
 * is touched: the sidecar tree collides where the object tree does not (`a` and `a.json/b`), and a
 * put() that wrote its bytes and then failed on its sidecar left an object nobody had recorded.
 */
async function claim(write: ObjectWrite, relative: string): Promise<void> {
  const { root, key } = write;
  const target = `${root}/${relative}`;
  try {
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  } catch (error) {
    const blocking = isPathConflict(error) ? await fileInTheWay(root, relative) : undefined;
    throw blocking === undefined ? error : keyConflict(write.disk, key, blocking);
  }
  let directory = false;
  try {
    directory = (await Bun.file(target).stat()).isDirectory();
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
  // The keys in the way live UNDER this path: `<key>/…`, or `<key>.json/…` in the sidecar tree.
  const beneath = relative.startsWith(`${META_DIR}/`)
    ? relative.slice(META_DIR.length + 1)
    : relative;
  if (directory) throw keyConflict(write.disk, key, `${beneath}/`);
}

const discard = async (path: string): Promise<void> => {
  await Bun.file(path)
    .delete()
    .catch(() => undefined);
};

export interface ObjectWrite {
  readonly root: string;
  readonly key: string;
  /** The name the disk was REGISTERED under — what a refusal's `disk('…')` call must name. */
  readonly disk: string;
  /** A `BunFile` is a `Blob`: a copy hands the source file over and no byte crosses the heap. */
  readonly body: Uint8Array | Blob;
  /** `etag` MUST be the body's own: it is what the pending marker announces. */
  readonly sidecar: Sidecar;
}

/** The four mutations a commit makes, in order — the seam a crash test dies at. */
export interface WriteSteps {
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const REAL_STEPS: WriteSteps = {
  rename: (from, to) => rename(from, to),
  unlink: async (path) => {
    await Bun.file(path).delete();
  },
};

/**
 * Stage three files, then four steps: (1) rename the pending MARKER, which holds the new etag;
 * (2) rename the sidecar; (3) rename the bytes; (4) remove the marker. Each rename replaces a
 * directory entry whole, so no reader ever opens half a file.
 *
 * The order is chosen by what a crash leaves (`driver-local-crash.test.ts` dies at every step):
 * - before (3), a FRESH key has no bytes file and so no object — absent, never half-present;
 * - before (2), an overwrite still has the previous sidecar over the previous bytes — whole;
 * - between (2) and (3), the new sidecar sits over the OLD bytes, and the marker naming that
 *   sidecar's etag is what tells `headObject` not to believe it;
 * - between (3) and (4) the pair is whole and still marked, so a read re-checks it and a listing
 *   reports it untyped until the next put.
 * Bytes-first has no such table: its torn overwrite is new bytes under the old type, undetectable.
 */
async function commit(write: ObjectWrite, steps: WriteSteps): Promise<void> {
  const sidecarPath = sidecarPathOf(write.key);
  const pendingPath = pendingPathOf(write.key);
  await claim(write, write.key);
  await claim(write, sidecarPath);
  await claim(write, pendingPath);
  const staged = `${write.root}/${STAGING_DIR}/${crypto.randomUUID()}`;
  // A second writer can make the colliding key between `claim` and the rename; only a RENAME's
  // refusal is that, never a failed staging write.
  const settle = async (suffix: string, relative: string): Promise<void> => {
    await steps.rename(`${staged}.${suffix}`, `${write.root}/${relative}`).catch((error) => {
      throw isPathConflict(error) ? keyConflict(write.disk, write.key, write.key) : error;
    });
  };
  try {
    await Bun.write(`${staged}.object`, write.body);
    await Bun.write(`${staged}.sidecar`, JSON.stringify(write.sidecar));
    await Bun.write(`${staged}.pending`, write.sidecar.etag);
    await settle('pending', pendingPath);
    await settle('sidecar', sidecarPath);
    await settle('object', write.key);
  } catch (error) {
    for (const suffix of ['object', 'sidecar', 'pending']) await discard(`${staged}.${suffix}`);
    throw error;
  }
  // The object is COMMITTED: all three renames landed. A marker that will not clear is not a
  // failed put — reporting one told the caller to retry a write every reader can already see.
  // What it leaves is exactly the crash-at-step-4 state, which `headObject` re-checks.
  await steps.unlink(`${write.root}/${pendingPath}`).catch(() => undefined);
}

/**
 * The local write, coded. Whatever the filesystem refuses with — `EACCES`, `ENOSPC`, `EROFS`, a
 * root that is a file — leaves here as `X_STORAGE_PUT_FAILED` carrying the errno, where it used to
 * be the bare `Error` out of `Bun.write`. A refusal this package already named passes through.
 */
export async function commitObject(
  write: ObjectWrite,
  steps: WriteSteps = REAL_STEPS,
): Promise<void> {
  try {
    await commit(write, steps);
  } catch (error) {
    if (isStorageError(error)) throw error;
    const at = renderFixShellArg(write.root, '<the disk root>');
    throw putFailed(write.disk, write.key, error, `ls -ld ${at} && df -h ${at}`);
  }
}

/** Runs `task` after every earlier task queued under the same key has settled. */
export type KeyedQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * One writer — or one reader — per key at a time, inside this process. An object is two files, so
 * two unserialised `put()`s of one key interleaved their four writes and left one's bytes under the
 * other's etag; a `get()` between a writer's two renames read the same mismatch.
 */
export function keyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      // Only the LAST task clears the entry, or a Map of every key ever written is a leak.
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
