// Single responsibility: framing a Server-Sent Events byte stream into `{ event, data }`
// frames. Protocol level only — nothing here knows what an Anthropic message looks like.
//
// Hand written rather than a dependency: the part of the SSE spec that matters to a provider
// stream is a boundary search and a field split, and the only interesting property — that a
// frame may arrive split at any byte offset — is exactly what a library would hide.

export interface SseFrame {
  /** The `event:` field, or `message` when the frame omits one — the spec's default. */
  readonly event: string;
  /** Every `data:` line of the frame, joined with `\n` as the spec requires. */
  readonly data: string;
}

/** `\r\n\r\n`, `\n\n` and `\r\r` all end a frame. A lone trailing `\r` is not yet a boundary. */
const BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
const LINE = /\r\n|\n|\r/;

/**
 * Split what has arrived so far into complete frames plus the unterminated remainder. Pure and
 * synchronous, so a test can feed it a stream chopped at any offset — which is the only thing
 * a network does that a fixture does not.
 */
export function decodeSse(buffer: string): { readonly frames: readonly SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const boundary = BOUNDARY.exec(rest);
    if (boundary === null) break;
    const frame = frameOf(rest.slice(0, boundary.index));
    if (frame !== undefined) frames.push(frame);
    rest = rest.slice(boundary.index + boundary[0].length);
  }
  return { frames, rest };
}

/** One frame's block of lines. `undefined` for a heartbeat comment, which carries no data. */
function frameOf(block: string): SseFrame | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(LINE)) {
    // A line starting with `:` is a comment — providers send them to hold the socket open.
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n') };
}

/**
 * Read a response body as SSE frames. The trailing partial buffer IS flushed as a final frame:
 * a stream cut mid-message must fail loudly at the consumer that parses it, and dropping the
 * tail silently would turn a truncated answer into a complete-looking one.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const decoded = decodeSse(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) yield frame;
    }
    buffer += decoder.decode();
    const tail = frameOf(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    // Releases the socket when a consumer abandons the stream half way — `for await` runs
    // this through the generator's `return()`, so an early `break` does not leak a connection.
    await reader.cancel().catch(() => undefined);
  }
}
