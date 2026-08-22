// The two writes every published entry point uses — one per fd. Its own module because there are
// two entry points too — `packages/cli/src/bin.ts` and `create-ultimate`'s — and the second
// shipped `process.stdout.write` + `process.exit`, the exact pair the note below exists to rule
// out. fd 2 exists because fd 1 is not always a log: under `x mcp serve --transport stdio` it is
// the protocol, and under `--json` it is one document a caller parses.

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
function writeTo(fd: 1 | 2, line: string): void {
  const buffer = Buffer.from(`${line}\n`);
  let written = 0;
  while (written < buffer.length) {
    try {
      written += writeSync(fd, buffer, written, buffer.length - written);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EAGAIN') throw cause;
    }
  }
}

export function writeLine(line: string): void {
  writeTo(1, line);
}

/**
 * The same write, on fd 2: for a line that is not the command's answer. `dispatch` sends a result
 * here when it declares `stream: 'stderr'` — `x mcp serve --transport stdio`, whose stdout carries
 * JSON-RPC frames and where a `✓ …` banner is a malformed one to whatever is reading.
 *
 * Every guarantee above is the same guarantee here, and that is the reason this is one loop and
 * not two: fd 2 is a pipe under `2>` and in CI exactly as fd 1 is, so a second copy would be a
 * second place for the truncation and the `EAGAIN` handling to drift apart.
 */
export function writeErrorLine(line: string): void {
  writeTo(2, line);
}
