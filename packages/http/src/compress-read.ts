// The one read of a response body the `compress` stage ever does: counted against the length the
// response declared, bounded by the request's deadline, and able to hand back everything it took
// so an answer it gave up on still arrives whole. Split from the rule that decides when to read.

type Reader = ReadableStreamDefaultReader<Uint8Array>;
type Read = Awaited<ReturnType<Reader['read']>>;
type GiveUp = 'longer-than-declared' | 'deadline' | 'read-failed';

/** What a counted read ended with: every byte, or the reason it stopped and how to carry on. */
export type Drained =
  | { readonly complete: true; readonly chunks: readonly Uint8Array[] }
  | {
      readonly complete: false;
      readonly chunks: readonly Uint8Array[];
      readonly reason: GiveUp;
      /** The read already asked of the source when the deadline won; its bytes still belong. */
      readonly pending?: Promise<Read>;
      readonly failure?: unknown;
    };

/** Undefined when the signal fires first. The read keeps going, and is the caller's to collect. */
const readBefore = (
  read: Promise<Read>,
  signal: AbortSignal | undefined,
): Promise<Read | undefined> => {
  if (signal === undefined) return read;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const expired = (): void => resolve(undefined);
    signal.addEventListener('abort', expired, { once: true });
    const settle = (): void => signal.removeEventListener('abort', expired);
    read.then(
      (value) => {
        settle();
        resolve(value);
      },
      (failure: unknown) => {
        settle();
        reject(failure);
      },
    );
  });
};

/**
 * Counted, because the header is a claim and only the header was checked. The buffer never holds
 * more than the declared length, which `inBounds` capped: the chunk that overruns is kept aside to
 * be sent on, never added. Bounded in time too: this runs after the deadline's race has ended, and
 * an answer that was going to send its headers at once must not wait on a body that stalled.
 */
export const drainCounted = async (
  reader: Reader,
  declared: number,
  signal: AbortSignal | undefined,
): Promise<Drained> => {
  const chunks: Uint8Array[] = [];
  let held = 0;
  for (;;) {
    const pending = reader.read();
    let next: Read | undefined;
    try {
      next = await readBefore(pending, signal);
    } catch (failure) {
      return { complete: false, chunks, reason: 'read-failed', failure };
    }
    if (next === undefined) {
      // Observed now, so a client that leaves before the replay is pulled cannot turn the source's
      // later failure into an unhandled rejection. The replay's construction pull happens to
      // observe it today (high-water mark 1); this must not depend on that. It still awaits it.
      pending.catch(() => undefined);
      return { complete: false, chunks, reason: 'deadline', pending };
    }
    if (next.done) return { complete: true, chunks };
    if (held + next.value.byteLength > declared) {
      chunks.push(next.value);
      return { complete: false, chunks, reason: 'longer-than-declared' };
    }
    chunks.push(next.value);
    held += next.value.byteLength;
  }
};

/** The bytes the read took, then the rest of the source, as if nothing had looked at them. */
export const replayDrained = (
  chunks: readonly Uint8Array[],
  reader: Reader,
  pending: Promise<Read> | undefined,
): ReadableStream<Uint8Array> => {
  const queue = [...chunks];
  let inFlight = pending;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const held = queue.shift();
      if (held !== undefined) {
        controller.enqueue(held);
        return;
      }
      const next = await (inFlight ?? reader.read());
      inFlight = undefined;
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
};

export const concatChunks = (chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};
