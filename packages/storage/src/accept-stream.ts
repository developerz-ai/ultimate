// Single responsibility: a signed upload taken as a STREAM — the head read and sniffed, the rest
// piped into `disk.putStream`, so memory per upload is the sniff window, not the body. A body that
// ends inside the window, an XML type or a head opening with `<` (a script can sit anywhere in
// either), and a required checksum nobody declared are read whole by `acceptSignedUpload`'s rule.

import { type AcceptSignedUploadInput, acceptSignedUpload, signedObjectPut } from './accept';
import type { StorageObject } from './driver';
import { checksumMismatch, tooLarge } from './errors';
import {
  isXmlType,
  opensWithMarkup,
  SNIFF_WINDOW_BYTES,
  uploadPolicy,
  validateStoredHead,
} from './upload';

export interface AcceptSignedUploadStreamInput extends Omit<AcceptSignedUploadInput, 'bytes'> {
  /** The request's body; `null` is an empty one. Read once, never buffered past the window. */
  readonly body: ReadableStream<Uint8Array> | null;
}

/** Chunks read until `window` bytes are in hand or the body ends; past `ceiling` it is refused. */
async function readHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  key: string,
  window: number,
  ceiling: number,
): Promise<{ readonly chunks: Uint8Array[]; readonly size: number; readonly done: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < window) {
    const next = await reader.read();
    if (next.done) return { chunks, size, done: true };
    chunks.push(next.value);
    size += next.value.byteLength;
    if (size > ceiling) throw tooLarge(key, size, ceiling);
  }
  return { chunks, size, done: false };
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array =>
  new Uint8Array(Bun.concatArrayBuffers([...chunks]));

/**
 * `acceptSignedUpload` for a body that may not fit in memory: the same gates, in the same order,
 * with the magic bytes judged on the head. Past the ceiling, or a declared checksum the bytes do
 * not hash to, the stream errors and `putStream` abandons the write: the key is as it was.
 */
export async function acceptSignedUploadStream(
  input: AcceptSignedUploadStreamInput,
): Promise<StorageObject> {
  const { key, contentType, maxBytes } = await signedObjectPut(input);
  const policy = input.policy ?? uploadPolicy();
  const ceiling = Math.min(policy.maxBytes, maxBytes ?? policy.maxBytes);
  const reader = (input.body ?? new Blob([]).stream()).getReader();
  let head: Awaited<ReturnType<typeof readHead>>;
  try {
    head = await readHead(reader, key, SNIFF_WINDOW_BYTES, ceiling);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const whole =
    head.done ||
    isXmlType(contentType) ||
    opensWithMarkup(concat(head.chunks)) ||
    (policy.requireChecksum && input.checksum === undefined);
  if (whole) {
    const chunks = [...head.chunks];
    let size = head.size;
    try {
      for (
        let next = head.done ? undefined : await reader.read();
        next !== undefined && !next.done;
        next = await reader.read()
      ) {
        size += next.value.byteLength;
        if (size > ceiling) throw tooLarge(key, size, ceiling);
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return acceptSignedUpload({ ...input, bytes: concat(chunks) });
  }
  // The head says more follows: `size + 1` is "at least one byte past it", so an XML or a cut
  // character is judged as a head, never as a whole body.
  validateStoredHead(
    { key, declaredContentType: contentType, head: concat(head.chunks), size: head.size + 1 },
    policy,
  );
  const hasher = input.checksum === undefined ? undefined : new Bun.CryptoHasher('sha256');
  let size = 0;
  const counted = (chunk: Uint8Array): Uint8Array => {
    size += chunk.byteLength;
    if (size > ceiling) throw tooLarge(key, size, ceiling);
    hasher?.update(chunk);
    return chunk;
  };
  const queued = head.chunks.slice();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const first = queued.shift();
      if (first !== undefined) return controller.enqueue(counted(first));
      const next = await reader.read();
      if (!next.done) return controller.enqueue(counted(next.value));
      const actual = hasher?.digest('base64');
      if (actual !== undefined && actual !== input.checksum) {
        throw checksumMismatch(key, input.checksum ?? 'none', actual);
      }
      controller.close();
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return input.disk.putStream(key, body, { maxBytes: ceiling, contentType });
}
