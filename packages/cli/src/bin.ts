#!/usr/bin/env bun
// The `x` entrypoint. Nothing lives here but argv, stdout and the exit code — every decision is in
// dispatch.ts, so the whole CLI is testable without spawning a process.

import { writeSync } from 'node:fs';
import { dispatch } from './dispatch';

/**
 * `writeSync` on fd 1, not `process.stdout.write`. The latter is ASYNCHRONOUS whenever stdout is a
 * pipe — CI, `| jq`, `$(x ... --json)` — so anything past the 64KB pipe buffer is queued, and the
 * `process.exit(code)` below discards the queue. Measured: a 100KB payload arrives as exactly
 * 65536 bytes through a pipe and complete on a terminal, where the same call is synchronous.
 *
 * Every `x` command must answer `--json`, and the pipe is the only reason `--json` exists — so a
 * write that truncates under one is the whole contract failing on its intended use. It bites the
 * largest outputs, which are the failing ones, which is when it costs the most.
 *
 * A `node:` API, and unavoidable: Bun has no synchronous stdout write of its own. The loop is
 * required too — one `writeSync` to a pipe may write fewer bytes than it was handed.
 */
function writeLine(line: string): void {
  const buffer = Buffer.from(`${line}\n`);
  let written = 0;
  while (written < buffer.length) {
    try {
      written += writeSync(1, buffer, written, buffer.length - written);
    } catch (cause) {
      // `EAGAIN` is "the pipe is full right now", not a failure. CI hands the process a
      // NON-BLOCKING stdout, where `writeSync` throws rather than blocking — so the loop that
      // fixed `--json` truncation took the whole command down on a runner, emitting nothing. The
      // reader drains in microseconds; the retry is the correct response to "would block".
      if ((cause as NodeJS.ErrnoException).code !== 'EAGAIN') throw cause;
    }
  }
}

const code = await dispatch({
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  env: Bun.env,
  bunVersion: Bun.version,
  write: writeLine,
});

process.exit(code);
