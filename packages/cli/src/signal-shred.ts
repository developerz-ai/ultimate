// Delete a plaintext buffer when the process is signalled, and then let the signal do what it
// came to do. A bare `process.once('SIGINT', shred)` ran the shred and SWALLOWED the signal — a
// listener replaces the default action — so Ctrl-C in `x secrets edit` left the command running.

export type Reraise = (signal: NodeJS.Signals) => void;

const reraiseDefault: Reraise = (signal) => {
  process.kill(process.pid, signal);
};

/**
 * Shred on SIGINT/SIGTERM, then re-raise the same signal: `once` has already removed this
 * listener, so the re-raised signal meets the default action and terminates. Returns the undo for
 * the normal path, which shreds in its own `finally`.
 */
export function shredOnSignal(shred: () => void, reraise: Reraise = reraiseDefault): () => void {
  const handler = (signal: NodeJS.Signals): void => {
    shred();
    reraise(signal);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
