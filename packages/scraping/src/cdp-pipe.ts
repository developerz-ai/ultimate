// One responsibility: CDP over the pipe `--remote-debugging-pipe` opens — Chrome reads commands on
// its fd 3 and writes replies and events on its fd 4, each message one JSON text ended by a NUL
// byte. This is the e2e driver's wire; the WebSocket in `cdp-connection.ts` is for a remote browser.
//
// Why a pipe rather than the WebSocket Chrome also offers: Bun 1.4.0's WebSocket client handed
// `onmessage` text spliced from several frames under the dummy's `offline-feed` load — 64
// unparseable frames in one run, one of them a `Runtime.evaluate` reply that then waited out its
// 30 s deadline. A frame nobody can parse has no `id`, so no layer above can even tell which call
// it lost. A pipe is bytes and a delimiter, read here, and nothing in between.

import type { CdpTransport } from './cdp-connection';

/** The two ends a transport needs: a sink for whole messages, and the byte stream Chrome writes. */
export interface PipeEnds {
  /** Write these bytes to Chrome's fd 3, in order. */
  readonly write: (bytes: Uint8Array) => void;
  /** Chrome's fd 4. */
  readonly read: ReadableStream<Uint8Array>;
  /** Release the write end — Chrome treats its fd 3 closing as the client going away. */
  readonly end: () => void;
}

const NUL = 0;

/** Concatenate two byte arrays; the reader only ever holds the unterminated tail. */
const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export function pipeTransport(ends: PipeEnds): CdpTransport {
  const encoder = new TextEncoder();
  let closed = false;
  const reader = ends.read.getReader();
  return {
    send(text: string): void {
      if (closed) return;
      const body = encoder.encode(text);
      const framed = new Uint8Array(body.length + 1);
      framed.set(body);
      framed[body.length] = NUL;
      ends.write(framed);
    },
    close(): void {
      if (closed) return;
      closed = true;
      ends.end();
      void reader.cancel().catch(() => undefined);
    },
    listen(handlers): void {
      void (async () => {
        // Split on BYTES, decoded per message: a multi-byte character may straddle two reads, and
        // decoding each read on its own would corrupt it — the failure this file exists to end.
        const decoder = new TextDecoder();
        let tail: Uint8Array = new Uint8Array(0);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            tail = join(tail, value);
            for (let at = tail.indexOf(NUL); at !== -1; at = tail.indexOf(NUL)) {
              handlers.message(decoder.decode(tail.subarray(0, at)));
              tail = tail.subarray(at + 1);
            }
          }
        } catch {
          // A read that fails is a pipe that is gone — reported as the close it is, below.
        }
        closed = true;
        handlers.closed('the browser closed the CDP pipe');
      })();
    },
  };
}
