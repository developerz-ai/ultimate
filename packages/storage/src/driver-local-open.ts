// Single responsibility: the local disk's PINNED read — the file opened and its revision checked
// against the etag, at the call and again at the first pull, so the bytes streamed are that
// revision's or the read refuses.

// why: Bun has no handle API — `Bun.file(path)` reopens the path at every read, which is the race
// this file exists to close, and `Bun.file(fd)` has no positioned read nor a close.
import { type FileHandle, open } from 'node:fs/promises';
import { etagOfFile, headObject, refusedRead } from './driver-local-read';
import { objectNotFound } from './errors';
import { revisionChanged } from './errors-stream';
import { type ByteRange, streamedRange } from './range';

/** What one pull reads: big enough to amortise a syscall, small enough to never matter. */
const CHUNK_BYTES = 256 * 1024;

export interface PinnedRead {
  readonly root: string;
  readonly key: string;
  readonly disk: string;
  readonly etag: string;
  readonly range?: ByteRange | undefined;
}

/** Closed, whatever the close says: a read that has its answer does not trade it for a close error. */
const closeQuietly = async (handle: FileHandle | undefined): Promise<void> => {
  try {
    await handle?.close();
  } catch {
    // Already closed, or the OS refused: either way the descriptor is no longer this read's.
  }
};

/**
 * One open file, proved to be revision `etag`: opened FIRST, then described by path. A write landing
 * in between leaves the handle on the old bytes and the description on the new ones, so it refuses
 * — never serves a mismatch. A commit writes the sidecar before it renames the bytes, so a handle
 * on new bytes always meets a description at least that new.
 */
async function openChecked(read: PinnedRead): Promise<{ handle: FileHandle; size: number }> {
  const { root, key, disk, etag } = read;
  const handle = await open(`${root}/${key}`, 'r').catch(refusedRead(root, key, disk));
  try {
    const entry = await headObject(root, key, () => etagOfFile(root, key, disk));
    if (entry === undefined) throw objectNotFound(disk, key);
    if (entry.etag !== etag) throw revisionChanged(disk, key, etag);
    return { handle, size: (await handle.stat()).size };
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
}

/**
 * The object at `key` as revision `etag`, or `X_STORAGE_OBJECT_CHANGED`; `range` as `streamRange`.
 * Checked NOW and closed again, so a stream nobody reads holds no descriptor; the first pull reopens
 * and checks the ETAG again. Never the inode alone: ext4 hands a freed inode straight back, so two
 * puts left v3 at v1's inode number and it was served under v1's etag.
 */
export async function streamPinned(read: PinnedRead): Promise<ReadableStream<Uint8Array>> {
  const { key, range } = read;
  const checked = await openChecked(read);
  await closeQuietly(checked.handle);
  const { size } = checked;
  const [first, last] =
    range === undefined ? [0, size - 1] : streamedRange('local', key, range, size);
  // The same etag is the same bytes, so the same size: the etag check is the whole proof.
  const reopen = async (): Promise<FileHandle> => (await openChecked(read)).handle;
  return streamOf(reopen, first, last + 1);
}

/** `[first, end)` off one handle opened at the first pull, closed on the last byte, a cancel or a failure. */
function streamOf(
  opener: () => Promise<FileHandle>,
  first: number,
  end: number,
): ReadableStream<Uint8Array> {
  let position = first;
  let handle: FileHandle | undefined;
  const close = async (): Promise<void> => {
    await closeQuietly(handle);
    handle = undefined;
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const want = Math.min(CHUNK_BYTES, end - position);
          if (want <= 0) {
            await close();
            return controller.close();
          }
          handle ??= await opener();
          const buffer = new Uint8Array(want);
          const { bytesRead } = await handle.read(buffer, 0, want, position);
          if (bytesRead === 0) {
            await close();
            return controller.close();
          }
          position += bytesRead;
          controller.enqueue(bytesRead === want ? buffer : buffer.subarray(0, bytesRead));
        } catch (error) {
          await close();
          controller.error(error);
        }
      },
      cancel: close,
    },
    // Pulled only when read: the default high-water mark of 1 pulls once at construction, which
    // opened a descriptor for a body nobody would ever read (a 304, a dropped client).
    { highWaterMark: 0 },
  );
}
