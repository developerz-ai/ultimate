// A root script stopped by SIGINT or SIGTERM stops every process it started: its children carry
// its tag in `STEP_TAG_ENV`, the tagged tree is killed, then the signal is re-raised.

import { stopChildrenOnSignal } from '../../packages/cli/src/upgrade-signals';
import { STEP_TAG_ENV } from '../../packages/cli/src/verify-deadline';

/**
 * Tag this process's environment, so every child `run()` spawns inherits it, and kill that tree
 * on a stop. A child `bun test` holds the ledger reservation it inherited (`withHeavy`'s fds); an
 * orphan kept it, and the machine queued behind a run nobody was waiting for. POSIX: the sweep
 * reads each process's environment, which Windows does not expose, and no gate-starting script
 * runs there. Returns the undo.
 */
export function stopTreeOnSignal(name: string): () => void {
  // Unique per process, so a nested script never kills its parent's tree.
  const tag = `${name}-${String(process.pid)}`;
  const inherited = process.env[STEP_TAG_ENV];
  process.env[STEP_TAG_ENV] =
    inherited === undefined || inherited === '' ? tag : `${inherited} ${tag}`;
  return stopChildrenOnSignal({ tag, pids: new Set(), cleanup: () => undefined });
}
