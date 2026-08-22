#!/usr/bin/env bun
// The `x` entrypoint. Nothing lives here but argv, stdout and the exit code — every decision is in
// dispatch.ts, so the whole CLI is testable without spawning a process.

import { dispatch } from './dispatch';
// The writes themselves are `write-line.ts`: `create-ultimate`'s entry point needs the identical
// one, and a second copy of a note about pipe truncation is a second copy that drifts. Two sinks,
// because fd 1 is not always this process's to write on — `x mcp serve --transport stdio` hands it
// to the protocol, and `dispatch` addresses that result to the second.
import { writeErrorLine, writeLine } from './write-line';

const code = await dispatch({
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  env: Bun.env,
  bunVersion: Bun.version,
  write: writeLine,
  writeError: writeErrorLine,
});

process.exit(code);
