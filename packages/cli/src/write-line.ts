// The one stdout write every published entry point uses. Its own module because there are two of
// them — `packages/cli/src/bin.ts` and `create-ultimate`'s — and the second shipped
// `process.stdout.write` + `process.exit`, the exact pair the note below exists to rule out.

// `node:fs`, and unavoidable: Bun has no synchronous stdout write of its own.
import { writeSync } from 'node:fs';

/**
 * Write to stdout and be certain it arrived, even if the next statement exits the process.
 *
 * `process.stdout.write()` is ASYNCHRONOUS whenever stdout is a pipe — which is what it is in CI
 * and under `| jq`. Anything past the 64KB pipe buffer is queued, and `process.exit()` discards the
 * queue, so the output silently truncates. A `--json` contract that truncates under a pipe is a
 * `--json` contract for nobody: the pipe is the only reason it exists.
 *
 * The loop is not decoration — one `writeSync` to a pipe may write fewer bytes than it was handed,
 * and dropping the remainder reintroduces the bug in a harder-to-see form.
 *
 * `EAGAIN` is "the pipe is full right now", not a failure. CI hands the process a NON-BLOCKING
 * stdout, where `writeSync` throws rather than blocking — so the loop that fixed the truncation
 * took the whole command down on a runner, emitting nothing at all. The reader drains in
 * microseconds; the retry is the correct response to "would block".
 */
export function writeLine(line: string): void {
  const buffer = Buffer.from(`${line}\n`);
  let written = 0;
  while (written < buffer.length) {
    try {
      written += writeSync(1, buffer, written, buffer.length - written);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EAGAIN') throw cause;
    }
  }
}
