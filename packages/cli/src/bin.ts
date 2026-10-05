#!/usr/bin/env bun
// The `x` entrypoint. Nothing lives here but argv, stdout and the exit code — every decision is in
// dispatch.ts, so the whole CLI is testable without spawning a process.

import { dispatch } from './dispatch';
import { resolveLocalCli } from './local-cli';
import { handOff } from './local-cli-handoff';
import { cwdFromArgv } from './root-env';
// The writes themselves are `write-line.ts`: `create-ultimate`'s entry point needs the identical
// one, and a second copy of a note about pipe truncation is a second copy that drifts. Two sinks,
// because fd 1 is not always this process's to write on — `x mcp serve --transport stdio` hands it
// to the protocol, and `dispatch` addresses that result to the second.
import { writeErrorLine, writeLine } from './write-line';

// An app's own CLI sees the app's entity registry; a global one does not. Hand over before
// deciding anything — see local-cli.ts for the zero-entity manifest this prevents. On fd 2, so a
// `--json` consumer reading fd 1 sees exactly the child's one document. `process.execPath` is the
// Bun that is already running, never a `PATH` lookup: the child's `import.meta.path` resolves to
// the app's file, so its own `resolveLocalCli` answers "same file" and the chain stops at one hop.
// `--cwd` decides WHICH app's CLI, exactly as it decides which app `dispatch` runs against.
const local = resolveLocalCli({
  cwd: cwdFromArgv(Bun.argv.slice(2), process.cwd()),
  selfPath: import.meta.path,
  env: Bun.env,
});
if (local !== undefined) {
  writeErrorLine(`x: using the app's own @ultimat3/cli at ${local}`);
  // Stop signals are forwarded and the child's code is ours: see local-cli-handoff.ts.
  process.exit(await handOff([process.execPath, local, ...Bun.argv.slice(2)], Bun.env));
}

// `x dev` supervises a child that serves (`dev-supervisor.ts`): a save that reaches a module which
// defines a primitive is a restart, since no re-import in one process can serve it. After the
// handoff above, so the supervisor and its children are the app's own CLI.
// Imported only for `dev`: every other command's process must not load, or register, anything more.
if (Bun.argv[2] === 'dev') {
  const { devSupervision, freeDevPort, superviseDev } = await import('./dev-supervisor');
  const supervision = devSupervision(Bun.argv.slice(2), Bun.env, freeDevPort);
  if (supervision !== undefined) {
    process.exit(
      await superviseDev({ bin: import.meta.path, argv: supervision.argv, env: Bun.env }),
    );
  }
}

const code = await dispatch({
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  env: Bun.env,
  bunVersion: Bun.version,
  write: writeLine,
  writeError: writeErrorLine,
});

process.exit(code);
