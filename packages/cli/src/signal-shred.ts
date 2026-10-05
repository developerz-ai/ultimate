// Delete a plaintext buffer when the process is signalled, and then let the signal do what it
// came to do. A bare `process.once('SIGINT', shred)` ran the shred and SWALLOWED the signal — a
// listener replaces the default action — so Ctrl-C in `x secrets edit` left the command running.

export type Reraise = (signal: NodeJS.Signals) => void;

/** Ctrl-C, a supervisor's stop, and a terminal closing under the editor. */
const SHRED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const reraiseDefault: Reraise = (signal) => {
  process.kill(process.pid, signal);
};

/**
 * Shred on SIGINT/SIGTERM/SIGHUP, then re-raise the same signal with the listeners gone, so it
 * meets the default action and terminates. Returns the undo for the normal path, which shreds in
 * its own `finally`.
 *
 * The listeners stay installed UNTIL the shred is done, and a repeat meanwhile is ignored. With
 * `once` the listener was gone the moment the first signal was dispatched, so a second one — a
 * Ctrl-C the terminal delivers to the whole group and a wrapper forwards again — met the default
 * action: a kernel-level kill mid-`rmSync`, the plaintext left in $TMPDIR (30 of 40 runs).
 */
export function shredOnSignal(shred: () => void, reraise: Reraise = reraiseDefault): () => void {
  let shredding = false;
  const undo = (): void => {
    for (const signal of SHRED_SIGNALS) process.off(signal, handler);
  };
  function handler(signal: NodeJS.Signals): void {
    if (shredding) return;
    shredding = true;
    try {
      shred();
    } finally {
      undo();
      reraise(signal);
    }
  }
  for (const signal of SHRED_SIGNALS) process.on(signal, handler);
  return undo;
}
