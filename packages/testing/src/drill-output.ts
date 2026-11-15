// A spawned role's output, as the drill reads it: the last of it, for a refusal's evidence, and a
// count of the whole lines naming one string, kept as they stream so no tail can cut one off.

const TAIL_CHARS = 8_000;

export interface DrillOutput {
  log(): string;
  /** Whole lines naming `watch`, per stream, the last unterminated one counted at its end. */
  watched(): number;
  /** Settles once every stream has been read to its end. */
  ended(): Promise<void>;
}

/** Read every stream to its end in the background; the answer reads what has arrived so far. */
export function tailOf(
  streams: readonly ReadableStream<Uint8Array>[],
  watch?: string,
): DrillOutput {
  let text = '';
  let watched = 0;
  const count = (line: string): void => {
    if (watch !== undefined && line.includes(watch)) watched += 1;
  };
  const readers = streams.map((stream) =>
    (async () => {
      const decoder = new TextDecoder();
      let partial = '';
      for await (const chunk of stream) {
        const decoded = decoder.decode(chunk, { stream: true });
        text = (text + decoded).slice(-TAIL_CHARS);
        const lines = (partial + decoded).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) count(line);
      }
      count(partial);
      // A stream that errors ends the read: what arrived before it is still the evidence.
    })().catch(() => undefined),
  );
  const ended = Promise.all(readers).then(() => undefined);
  return { log: () => text, watched: () => watched, ended: () => ended };
}
