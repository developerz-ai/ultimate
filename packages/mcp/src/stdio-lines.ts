// Raw stdin chunks → newline-delimited frames, the line cap measured in BYTES before anything is
// decoded. A `string.length` cap counted UTF-16 units: a 1 MiB cap admitted ~3 MiB of CJK.
// Splitting on 0x0A is safe on the raw bytes — UTF-8 never uses that byte inside a character.

/** One unit of the wire: a complete line's text, or a line refused for its size. */
export type StdioFrame =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'over-limit' };

export interface LineSplitter {
  /** The frames this chunk completes, in wire order. */
  push(chunk: Uint8Array): readonly StdioFrame[];
  /** The trailing message with no newline — still a message, unless it is a dropped tail. */
  end(): readonly StdioFrame[];
}

const NEWLINE = 0x0a;
const OVER: StdioFrame = { kind: 'over-limit' };

export function lineSplitter(limit: number): LineSplitter {
  const decoder = new TextDecoder();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  // The rest of an over-long message is dropped, never parsed: whatever follows it on the same
  // line is the tail of a message this transport refused, not a message of its own.
  let discarding = false;

  const take = (last: Uint8Array): string => {
    const whole = new Uint8Array(pendingBytes + last.length);
    let at = 0;
    for (const part of pending) {
      whole.set(part, at);
      at += part.length;
    }
    whole.set(last, at);
    pending = [];
    pendingBytes = 0;
    return decoder.decode(whole);
  };

  return {
    push(chunk) {
      const frames: StdioFrame[] = [];
      let start = 0;
      while (start <= chunk.length) {
        const newline = chunk.indexOf(NEWLINE, start);
        const segment = chunk.subarray(start, newline === -1 ? chunk.length : newline);
        if (newline === -1) {
          if (!discarding && segment.length > 0) {
            // Judged while buffering, so a stream with no newline never grows past the cap.
            if (pendingBytes + segment.length > limit) {
              frames.push(OVER);
              pending = [];
              pendingBytes = 0;
              discarding = true;
            } else {
              // A copy: the stream may hand the same buffer back refilled.
              pending.push(segment.slice());
              pendingBytes += segment.length;
            }
          }
          break;
        }
        if (discarding) discarding = false;
        // Judged before the decode and the parse: a line over the cap costs neither.
        else if (pendingBytes + segment.length > limit) {
          frames.push(OVER);
          pending = [];
          pendingBytes = 0;
        } else frames.push({ kind: 'line', text: take(segment) });
        start = newline + 1;
      }
      return frames;
    },
    end() {
      if (discarding || pendingBytes === 0) return [];
      return [{ kind: 'line', text: take(new Uint8Array(0)) }];
    },
  };
}
