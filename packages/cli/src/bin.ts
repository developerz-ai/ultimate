#!/usr/bin/env bun
// The `x` entrypoint. Nothing lives here but argv, stdout and the exit code — every decision is in
// dispatch.ts, so the whole CLI is testable without spawning a process.

import { dispatch } from './dispatch';
// The write itself is `write-line.ts`: `create-ultimate`'s entry point needs the identical one,
// and a second copy of a note about pipe truncation is a second copy that drifts.
import { writeLine } from './write-line';

const code = await dispatch({
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  env: Bun.env,
  bunVersion: Bun.version,
  write: writeLine,
});

process.exit(code);
