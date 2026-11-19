// `@ultimat3/core/internal/sse-frames` — the ONE reader of a `text/event-stream` body's frames: the
// browser's `clientStream` and `@ultimat3/mcp`'s remote client both split SSE here. INTERNAL and a
// leaf: a package's wire reader, never an app's, and it imports nothing.

/** One complete frame: its `event` (`message` when unnamed) and its `data:` lines joined. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
  /** The `x-ultimate-dates` value for this frame's data, when the server named any. */
  readonly dates?: string;
}

/**
 * Splits a growing buffer into complete frames; the incomplete tail is handed back. A frame with
 * no `data:` line (a keep-alive comment, a bare `event:`) is no frame. A whole body read at once
 * is `takeFrames(`${text}\n\n`)`: its last frame needs no blank line after it.
 */
export function takeFrames(buffer: string): {
  readonly frames: SseFrame[];
  readonly rest: string;
} {
  const frames: SseFrame[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let dates: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      // A `:` line is a comment — the server's keep-alive.
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('dates:')) dates = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) {
      const text = data.join('\n');
      frames.push(dates === undefined ? { event, data: text } : { event, data: text, dates });
    }
  }
  return { frames, rest };
}
