// The two writes every published entry point uses, one per fd — `packages/cli/src/bin.ts` and
// `create-ultimate`'s, the second of which shipped the `process.stdout.write` + `process.exit`
// pair the note below rules out. fd 2 exists because fd 1 is not always a log: under
// `x mcp serve --transport stdio` it is the protocol, under `--json` one document a caller parses.

// `node:fs`, and unavoidable: Bun has no synchronous stdout write of its own.
import { writeSync } from 'node:fs';
// The one import beyond `node:fs`, and it costs nothing here: `create-ultimate` reaches this
// module through `@ultimat3/cli`'s barrel, which has already evaluated core.
import { backoffDelay, stringField } from '@ultimat3/core';

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
 * took the whole command down on a runner, emitting nothing at all. A draining reader clears it in
 * microseconds, so it is retried — but BOUNDED: a reader that never drains (a stopped `| less`, a
 * wedged parent) turned the unbounded retry into a command that never exits, spinning a core.
 * `EAGAIN_ATTEMPTS` consecutive stalls, each waiting longer (capped), then the line is dropped and
 * counted (`droppedLineCount()`): one lost line beats a process that cannot finish.
 */
function writeTo(fd: 1 | 2, line: string): void {
  writeAll(fd, Buffer.from(`${line}\n`));
}

/** Consecutive stalls one write may absorb before its line is dropped. Progress resets it. */
export const EAGAIN_ATTEMPTS = 50;

/**
 * Core's one curve, exponential and capped: 1, 2, 4 … 32 ms — under 1.5 s for a reader that never
 * drains at all. No jitter: one process waiting on its own pipe has no herd to decorrelate.
 */
const backoffMs = (stall: number): number => backoffDelay({ attempt: stall, base: 1, max: 32 });

/** `writeSync`'s shape, so a test can hand in a pipe that is full forever. */
export type WriteSync = (fd: number, buffer: Uint8Array, offset: number, length: number) => number;

let dropped = 0;

/** Lines this process dropped to a reader that never drained. */
export const droppedLineCount = (): number => dropped;

/**
 * Write every byte of `buffer` to `fd`, or drop it after `EAGAIN_ATTEMPTS` stalls in a row.
 * Returns whether it all arrived. A write of zero bytes is a stall too, so no path spins.
 */
export function writeAll(
  fd: number,
  buffer: Uint8Array,
  write: WriteSync = writeSync,
  sleep: (ms: number) => void = Bun.sleepSync,
): boolean {
  let written = 0;
  let stalls = 0;
  while (written < buffer.length) {
    let progress = 0;
    try {
      progress = write(fd, buffer, written, buffer.length - written);
    } catch (cause) {
      // `stringField`, never a cast plus a property read — the rule `metrics-endpoint.ts` states
      // and `caught-value-reads.test.ts` enforces. Here it is also the difference between
      // rethrowing and retrying: a `code` that cannot be read must not read as `EAGAIN`.
      if (stringField(cause, 'code') !== 'EAGAIN') throw cause;
    }
    if (progress > 0) {
      written += progress;
      stalls = 0;
      continue;
    }
    stalls += 1;
    if (stalls >= EAGAIN_ATTEMPTS) {
      dropped += 1;
      return false;
    }
    sleep(backoffMs(stalls));
  }
  return true;
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
