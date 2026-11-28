// A reference directory appears WHOLE or not at all: built in `<dir>.tmp-<pid>-<id>`, swapped in
// only once complete, runs into one directory in this process taking turns.
//
// `x shot --against` diffs whatever shots a `<slug>/` holds, so a slug mixing two runs — a cancelled
// one beside its retry, a failed or narrower rerun over an older one — is a comparison against a
// reference that never existed (`repro-archive-write.ts`'s rule).

// why: Bun has no directory rename or recursive remove.
import { mkdir, rename, rm } from 'node:fs/promises';

/** The tail of the last run per directory; a run waits for it, failed or not. */
const queues = new Map<string, Promise<unknown>>();

const scratchName = (dir: string, kind: string): string =>
  `${dir}.${kind}-${String(process.pid)}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Two renames, because a directory is never renamed over a non-empty one: the old run steps aside,
 * the new one steps in, the old one is removed. A crash between the two leaves the old run under a
 * `.old-` name, never a half-written `<dir>`.
 */
async function swapIn(building: string, dir: string): Promise<void> {
  const old = scratchName(dir, 'old');
  const moved = await rename(dir, old).then(
    () => true,
    (error: unknown) => {
      if ((error as { code?: unknown }).code === 'ENOENT') return false;
      throw error;
    },
  );
  await rename(building, dir);
  if (moved) await rm(old, { recursive: true, force: true });
}

async function buildAndSwap<T>(dir: string, build: (building: string) => Promise<T>): Promise<T> {
  const building = scratchName(dir, 'tmp');
  try {
    await mkdir(building, { recursive: true });
    const result = await build(building);
    await swapIn(building, dir);
    return result;
  } finally {
    await rm(building, { recursive: true, force: true });
  }
}

/** `build` writes into a fresh scratch directory; `dir` becomes it only when `build` resolves. */
export function publishDirectory<T>(
  dir: string,
  build: (building: string) => Promise<T>,
): Promise<T> {
  const previous = queues.get(dir) ?? Promise.resolve();
  const run = previous.then(
    () => buildAndSwap(dir, build),
    () => buildAndSwap(dir, build),
  );
  const tail = run.catch(() => undefined);
  queues.set(dir, tail);
  // Forgotten once nothing is queued behind it: the map holds live work, not every slug ever seen.
  void tail.then(() => {
    if (queues.get(dir) === tail) queues.delete(dir);
  });
  return run;
}
