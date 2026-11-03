// Single responsibility: the local disk's `putStream`: the body counted and hashed into one staged
// file the commit renames into place, so any length costs one chunk of heap. Staged outside the key's
// queue, so a slow sender does not hold the key's readers.

// why: Bun has no `mkdir`; `Bun.write` makes parents but cannot open the incremental writer here.
import { mkdir } from 'node:fs/promises';
import { type Clock, isUltimateError, renderFixShellArg } from '@ultimat3/core';
import { pumpBounded } from './byte-pump';
import { DEFAULT_CONTENT_TYPE, type StorageObject } from './driver';
import type { Sidecar } from './driver-local-sidecar';
import { commitObject, STAGING_DIR } from './driver-local-write';
import { putFailed } from './errors';
import type { PutStreamOptions } from './put-stream';
import { streamLimit } from './put-stream';

export interface StagedStream {
  readonly path: string;
  readonly size: number;
  /** `etagOf` over the same bytes, so a streamed object and a `put()` of it report one etag. */
  readonly etag: string;
}

export interface LocalStreamInput extends StageStreamInput {
  readonly clock: Clock;
}

/**
 * Stage, then commit. `inTurn` is the disk's lock check in the key's turn, then `then`: asked before
 * the transfer too, because a locked key should not cost the whole body to refuse.
 */
export async function putLocalStream(
  input: LocalStreamInput,
  options: PutStreamOptions,
  inTurn: (then: () => Promise<void>) => Promise<void>,
): Promise<StorageObject> {
  const { root, key, disk, clock } = input;
  await inTurn(async () => undefined);
  const staged = await stageStream(input);
  try {
    const lastModified = clock.now();
    const sidecar: Sidecar = {
      contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
      etag: staged.etag,
      cacheControl: options.cacheControl,
      metadata: options.metadata,
      lastModified: lastModified.toISOString(),
    };
    const body = { stagedAt: staged.path };
    await inTurn(() => commitObject({ root, key, disk, body, sidecar }));
    return {
      key,
      size: staged.size,
      contentType: sidecar.contentType,
      etag: sidecar.etag,
      lastModified,
      ...(sidecar.cacheControl === undefined ? {} : { cacheControl: sidecar.cacheControl }),
      ...(sidecar.metadata === undefined ? {} : { metadata: sidecar.metadata }),
    };
  } finally {
    await discardStaged(staged.path);
  }
}

export interface StageStreamInput {
  readonly root: string;
  readonly key: string;
  readonly disk: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly maxBytes: number;
}

/** A staged file gone, or never there. Safe after the commit renamed it away. */
export const discardStaged = async (path: string): Promise<void> => {
  await Bun.file(path)
    .delete()
    .catch(() => undefined);
};

/** Backpressure is the `flush`: awaiting it is what keeps a fast sender from filling the heap. */
export async function stageStream(input: StageStreamInput): Promise<StagedStream> {
  const { root, key, disk, body, maxBytes } = input;
  const path = `${root}/${STAGING_DIR}/${crypto.randomUUID()}.incoming`;
  const hasher = new Bun.CryptoHasher('sha256');
  let sink: ReturnType<ReturnType<typeof Bun.file>['writer']> | undefined;
  try {
    await mkdir(`${root}/${STAGING_DIR}`, { recursive: true });
    const open = Bun.file(path).writer();
    sink = open;
    const size = await pumpBounded(body, streamLimit('local', key, maxBytes), async (chunk) => {
      hasher.update(chunk);
      open.write(chunk);
      await open.flush();
    });
    await open.end();
    sink = undefined;
    return { path, size, etag: hasher.digest('hex').slice(0, 32) };
  } catch (error) {
    await Promise.resolve(sink?.end()).catch(() => undefined);
    await discardStaged(path);
    if (isUltimateError(error)) throw error;
    const at = renderFixShellArg(root, '<the disk root>');
    throw putFailed(disk, key, error, `ls -ld ${at} && df -h ${at}`);
  }
}
